use std::error::Error as StdError;
use std::path::Path;
use std::time::Duration;

use tauri::http::{Response, StatusCode};
use tauri_plugin_http::reqwest;

use crate::utils::http::get_client;

const RETRY_DELAYS_MS: &[u64] = &[100, 300];

pub fn infer_image_extension(url: &str) -> Option<String> {
    let parsed_url = url::Url::parse(url).ok()?;
    infer_image_extension_from_path(parsed_url.path())
}

fn infer_image_extension_from_path(path: &str) -> Option<String> {
    let file_name = path.rsplit('/').next()?;
    file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext.trim().to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
}

pub fn content_type_for_extension(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

pub fn content_type_for_file(path: &Path) -> &'static str {
    content_type_for_extension(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref()
            .unwrap_or(""),
    )
}

pub fn make_image_response(
    bytes: Vec<u8>,
    content_type: &str,
    cache_control: &str,
) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", content_type)
        .header("Cache-Control", cache_control)
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .expect("failed to build image response")
}

pub fn make_status_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("failed to build status response")
}

// ==================== 图片代理协议 ====================

fn format_error_chain(error: &reqwest::Error) -> String {
    let mut causes = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        causes.push(cause.to_string());
        source = cause.source();
    }
    causes.join(" -> ")
}

fn image_origin_for_logs(url: &url::Url) -> String {
    url.origin().ascii_serialization()
}

fn log_image_request_failure(origin: &str, attempts: usize, error: reqwest::Error) {
    let error = error.without_url();
    log::warn!(
        "代理图片请求失败 origin={} attempts={} connect={} timeout={} request={} error={} causes={}",
        origin,
        attempts,
        error.is_connect(),
        error.is_timeout(),
        error.is_request(),
        error,
        format_error_chain(&error)
    );
}

fn retry_delay_after_failure(
    completed_attempts: usize,
    is_connect_error: bool,
    is_timeout_error: bool,
) -> Option<Duration> {
    if !is_connect_error && !is_timeout_error {
        return None;
    }

    let retry_index = completed_attempts.checked_sub(1)?;
    RETRY_DELAYS_MS
        .get(retry_index)
        .copied()
        .map(Duration::from_millis)
}

async fn send_image_request(url: &str, log_origin: &str) -> Result<reqwest::Response, StatusCode> {
    let mut completed_attempts = 0;

    loop {
        completed_attempts += 1;
        match get_client().get(url).send().await {
            Ok(response) => return Ok(response),
            Err(error) => {
                let retry_delay = retry_delay_after_failure(
                    completed_attempts,
                    error.is_connect(),
                    error.is_timeout(),
                );
                if let Some(delay) = retry_delay {
                    log::debug!(
                        "代理图片请求重试 origin={} attempt={} delay={}ms",
                        log_origin,
                        completed_attempts + 1,
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }

                log_image_request_failure(log_origin, completed_attempts, error);
                return Err(StatusCode::BAD_GATEWAY);
            }
        }
    }
}

fn resolve_image_content_type(
    response_content_type: Option<&str>,
    source_url: &url::Url,
) -> Result<String, StatusCode> {
    if let Some(content_type) = response_content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| value.starts_with("image/"))
    {
        return Ok(content_type.to_owned());
    }

    let inferred_content_type = infer_image_extension_from_path(source_url.path())
        .map(|extension| content_type_for_extension(&extension))
        .filter(|content_type| content_type.starts_with("image/"))
        .map(str::to_owned);

    inferred_content_type.ok_or(StatusCode::UNSUPPORTED_MEDIA_TYPE)
}

async fn fetch_image(url: &str) -> Result<(Vec<u8>, String), StatusCode> {
    let parsed = url::Url::parse(url).map_err(|_| StatusCode::BAD_REQUEST)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(StatusCode::BAD_REQUEST);
    }

    let log_origin = image_origin_for_logs(&parsed);
    let response = send_image_request(url, &log_origin).await?;

    if !response.status().is_success() {
        log::warn!(
            "代理图片响应状态异常 origin={} status={}",
            log_origin,
            response.status()
        );
        return Err(StatusCode::BAD_GATEWAY);
    }

    let response_content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok());
    let content_type = resolve_image_content_type(response_content_type, &parsed)?;

    let bytes = response.bytes().await.map_err(|error| {
        let error = error.without_url();
        log::warn!("读取代理图片响应失败 origin={}: {}", log_origin, error);
        StatusCode::BAD_GATEWAY
    })?;

    Ok((bytes.to_vec(), content_type))
}

pub fn register_image_proxy_protocol<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("skerry-image", |_app, request, responder| {
        let request_uri = request.uri().to_string();

        tauri::async_runtime::spawn(async move {
            let parsed = match url::Url::parse(&request_uri) {
                Ok(url) => url,
                Err(_) => {
                    responder.respond(make_status_response(StatusCode::BAD_REQUEST));
                    return;
                }
            };

            let image_url = parsed
                .query_pairs()
                .find(|(key, _)| key == "url")
                .map(|(_, value)| value.into_owned());
            let Some(image_url) = image_url else {
                responder.respond(make_status_response(StatusCode::BAD_REQUEST));
                return;
            };

            match fetch_image(&image_url).await {
                Ok((bytes, content_type)) => responder.respond(make_image_response(
                    bytes,
                    &content_type,
                    "private, max-age=3600",
                )),
                Err(status) => responder.respond(make_status_response(status)),
            }
        });
    })
}

#[cfg(test)]
mod tests {
    use super::{
        fetch_image, image_origin_for_logs, infer_image_extension, resolve_image_content_type,
        retry_delay_after_failure,
    };
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;
    use tauri::http::StatusCode;

    fn serve_http_response(
        response: &'static [u8],
    ) -> (std::net::SocketAddr, thread::JoinHandle<()>) {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).expect("loopback HTTP server should bind");
        let address = listener
            .local_addr()
            .expect("loopback HTTP server should expose its address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener
                .accept()
                .expect("image request should reach the loopback server");
            let mut request = [0; 1024];
            stream
                .read(&mut request)
                .expect("HTTP request should be readable");
            stream
                .write_all(response)
                .expect("HTTP response should be writable");
        });
        (address, server)
    }

    #[tokio::test]
    async fn image_fetch_uses_the_http_response_and_preserves_response_contract() {
        let (address, server) = serve_http_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: image/webp; charset=binary\r\nContent-Length: 4\r\nConnection: close\r\n\r\nimg!",
        );

        let result = fetch_image(&format!("http://{address}/cover.jpg"))
            .await
            .expect("successful image response should be returned");
        server.join().expect("loopback server should finish");

        assert_eq!(result.0, b"img!");
        assert_eq!(result.1, "image/webp");
    }

    #[tokio::test]
    async fn image_fetch_maps_an_unsuccessful_http_status_to_bad_gateway() {
        let (address, server) = serve_http_response(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );

        let result = fetch_image(&format!("http://{address}/cover.jpg")).await;
        server.join().expect("loopback server should finish");

        assert_eq!(result, Err(StatusCode::BAD_GATEWAY));
    }

    #[test]
    fn retry_policy_uses_the_existing_bounded_schedule_only_for_connect_and_timeout_errors() {
        assert_eq!(
            retry_delay_after_failure(1, true, false),
            Some(Duration::from_millis(100))
        );
        assert_eq!(
            retry_delay_after_failure(2, false, true),
            Some(Duration::from_millis(300))
        );
        assert_eq!(retry_delay_after_failure(3, true, false), None);
        assert_eq!(retry_delay_after_failure(1, false, false), None);
        assert_eq!(retry_delay_after_failure(0, true, false), None);
    }

    #[test]
    fn response_image_type_wins_over_the_url_extension_and_drops_parameters() {
        let source_url = url::Url::parse("https://cdn.test/a.png").unwrap();

        assert_eq!(
            resolve_image_content_type(Some("image/webp; charset=binary"), &source_url),
            Ok("image/webp".to_string())
        );
    }

    #[test]
    fn non_image_response_type_falls_back_to_the_source_url_extension() {
        let source_url = url::Url::parse("https://cdn.test/a.JPG?token=private").unwrap();

        assert_eq!(
            resolve_image_content_type(Some("text/html; charset=utf-8"), &source_url),
            Ok("image/jpeg".to_string())
        );
    }

    #[test]
    fn unsupported_response_type_and_extension_return_415() {
        let source_with_unknown_extension = url::Url::parse("https://cdn.test/data.bin").unwrap();
        let source_without_extension = url::Url::parse("https://cdn.test/data").unwrap();

        assert_eq!(
            resolve_image_content_type(Some("application/json"), &source_with_unknown_extension),
            Err(StatusCode::UNSUPPORTED_MEDIA_TYPE)
        );
        assert_eq!(
            resolve_image_content_type(None, &source_without_extension),
            Err(StatusCode::UNSUPPORTED_MEDIA_TYPE)
        );
    }

    #[test]
    fn inferred_image_extension_comes_from_url_path_only() {
        assert_eq!(
            infer_image_extension("https://cdn.test/images/cover.JpG?token=private#preview"),
            Some("jpg".to_string())
        );
        assert_eq!(infer_image_extension("https://avatar.jpg"), None);
        assert_eq!(
            infer_image_extension("https://cdn.test/images/no-extension?file=cover.png"),
            None
        );
    }

    #[test]
    fn image_log_origin_excludes_credentials_path_query_and_fragment() {
        let url = url::Url::parse(
            "https://user:secret@cdn.example:8443/images/cover.jpg?token=private#section",
        )
        .expect("test image URL should parse");

        assert_eq!(image_origin_for_logs(&url), "https://cdn.example:8443");
    }
}
