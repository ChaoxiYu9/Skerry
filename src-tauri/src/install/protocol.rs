pub use crate::utils::fs::validate_safe_relative_path;
#[cfg(feature = "tauri-app")]
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(feature = "tauri-app")]
use std::collections::{HashSet, VecDeque};
use std::path::{Component, Path};
#[cfg(feature = "tauri-app")]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[cfg(feature = "tauri-app")]
use tokio::net::TcpListener;
use url::Url;

#[cfg(feature = "tauri-app")]
use tauri::{App, Emitter, Manager};
#[cfg(feature = "tauri-app")]
use tauri_plugin_deep_link::DeepLinkExt;

// 系统注册的是整个 scheme；install 只是当前一键安装入口使用的 host。
const INSTALL_SCHEME: &str = "skerry";
const INSTALL_HOST: &str = "install";
#[cfg(feature = "tauri-app")]
const DOWNLOAD_BRIDGE_ADDR: &str = "127.0.0.1:17832";
#[cfg(feature = "tauri-app")]
const DOWNLOAD_BRIDGE_PATH: &str = "/api/browser-download";
const SUPPORTED_PROTOCOL_VERSION: u32 = 1;
const SUPPORTED_REQUEST_PARAMS: &[&str] = &[
    "v",
    "provider",
    "resource_id",
    "url",
    "file_name",
    "archive_format",
    "size",
    "checksum_algo",
    "checksum",
    "expires_at",
    "bgm_id",
    "vndb_id",
    "hikarinagi_id",
    "title",
];
const SUPPORTED_ARCHIVE_FORMATS: &[&str] = &[
    "7z", "zip", "rar", "tar", "tar.gz", "tar.bz2", "tar.xz", "tar.zst",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallRequest {
    pub v: u32,
    pub provider: String,
    pub resource_id: String,
    pub url: String,
    pub file_name: String,
    pub archive_format: String,
    pub size: u64,
    pub checksum_algo: String,
    pub checksum: String,
    pub expires_at: Option<i64>,
    pub bgm_id: Option<String>,
    pub vndb_id: Option<String>,
    pub hikarinagi_id: Option<String>,
    pub title: String,
}

impl InstallRequest {
    pub fn validate(self) -> Result<Self, String> {
        if self.v != SUPPORTED_PROTOCOL_VERSION {
            return Err(format!("不支持的安装协议版本: {}", self.v));
        }
        validate_identifier("provider", &self.provider)?;
        if self.resource_id.trim().is_empty() || self.resource_id.len() > 256 {
            return Err("resource_id 为空或过长".to_string());
        }

        let download_url = Url::parse(&self.url).map_err(|_| "下载 URL 无效".to_string())?;
        if !matches!(download_url.scheme(), "http" | "https") {
            return Err("下载 URL 仅支持 HTTP/HTTPS".to_string());
        }
        if download_url.host_str().is_none() {
            return Err("下载 URL 缺少主机名".to_string());
        }

        validate_file_name(&self.file_name)?;
        if !SUPPORTED_ARCHIVE_FORMATS.contains(&self.archive_format.as_str()) {
            return Err(format!("不支持的压缩格式: {}", self.archive_format));
        }
        if self.size == 0 || self.size > i64::MAX as u64 {
            return Err("文件大小无效".to_string());
        }
        if !matches!(self.checksum_algo.as_str(), "sha256" | "blake3") {
            return Err(format!("不支持的校验算法: {}", self.checksum_algo));
        }
        if self.checksum.len() != 64 || !self.checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("校验值必须是 64 位十六进制字符串".to_string());
        }
        if self.expires_at.is_some_and(|value| value <= 0) {
            return Err("expires_at 无效".to_string());
        }
        if self
            .bgm_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("bgm_id 不能为空".to_string());
        }
        if self
            .vndb_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("vndb_id 不能为空".to_string());
        }
        if self
            .hikarinagi_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("hikarinagi_id 不能为空".to_string());
        }
        if self.title.trim().is_empty() {
            return Err("title 不能为空".to_string());
        }
        Ok(self)
    }

    #[cfg(feature = "tauri-app")]
    fn deduplication_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            self.provider, self.resource_id, self.checksum, self.url
        )
    }
}

#[cfg(feature = "tauri-app")]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InstallRequestRejection {
    pub code: String,
    pub message: String,
}

#[cfg(feature = "tauri-app")]
#[derive(Default)]
struct PendingProtocolData {
    requests: VecDeque<InstallRequest>,
    request_keys: HashSet<String>,
    rejections: VecDeque<InstallRequestRejection>,
}

#[cfg(feature = "tauri-app")]
#[derive(Default)]
pub struct InstallProtocolState {
    pending: Mutex<PendingProtocolData>,
}



#[cfg(feature = "tauri-app")]
impl InstallProtocolState {
    fn push_request(&self, request: InstallRequest) -> bool {
        let key = request.deduplication_key();
        let mut pending = self.pending.lock();
        if !pending.request_keys.insert(key) {
            return false;
        }
        pending.requests.push_back(request);
        true
    }

    fn push_rejection(&self, message: String) {
        self.pending
            .lock()
            .rejections
            .push_back(InstallRequestRejection {
                code: "invalid_install_request".to_string(),
                message,
            });
    }

    fn take_requests(&self) -> Vec<InstallRequest> {
        let mut pending = self.pending.lock();
        let requests = pending.requests.drain(..).collect::<Vec<_>>();
        pending.request_keys.clear();
        requests
    }

    fn take_rejections(&self) -> Vec<InstallRequestRejection> {
        self.pending.lock().rejections.drain(..).collect()
    }
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn take_pending_install_requests(
    state: tauri::State<'_, InstallProtocolState>,
) -> Vec<InstallRequest> {
    state.take_requests()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn take_pending_install_rejections(
    state: tauri::State<'_, InstallProtocolState>,
) -> Vec<InstallRequestRejection> {
    state.take_rejections()
}

#[cfg(feature = "tauri-app")]
pub fn setup_install_protocol(app: &App) {
    setup_browser_download_bridge(app.handle());
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            dispatch_protocol_url(&handle, url);
        }
    });

    match app.deep_link().get_current() {
        Ok(Some(urls)) => {
            for url in urls {
                dispatch_protocol_url(app.handle(), url);
            }
        }
        Ok(None) => {}
        Err(error) => log::warn!("读取启动安装协议失败: {error}"),
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    if let Err(error) = app.deep_link().register_all() {
        log::warn!(
            target: "install_protocol",
            "注册 skerry 协议失败: os={}, executable={}, error={error}",
            std::env::consts::OS,
            current_executable_for_log(),
        );
    }
}

/// Accepts browser download payloads over a loopback HTTP endpoint. The
/// extension uses this before opening `skerry://`, which avoids Chrome's
/// external-protocol confirmation dialog while Skerry is already running.
#[cfg(feature = "tauri-app")]
fn setup_browser_download_bridge(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(DOWNLOAD_BRIDGE_ADDR).await {
            Ok(listener) => listener,
            Err(error) => {
                log::warn!(
                    target: "install_protocol",
                    "无法启动浏览器下载本机桥接 {}: {error}",
                    DOWNLOAD_BRIDGE_ADDR
                );
                return;
            }
        };
        log::debug!(
            target: "install_protocol",
            "浏览器下载本机桥接已监听 {}",
            DOWNLOAD_BRIDGE_ADDR
        );
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = handle_browser_download_bridge(stream, &app).await {
                    log::debug!(target: "install_protocol", "浏览器下载桥接请求失败: {error}");
                }
            });
        }
    });
}

#[cfg(feature = "tauri-app")]
async fn handle_browser_download_bridge(
    mut stream: tokio::net::TcpStream,
    _app: &tauri::AppHandle,
) -> Result<(), String> {
    let mut data = Vec::with_capacity(8192);
    let mut chunk = [0_u8; 8192];
    let header_end;
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("浏览器桥接连接提前关闭".to_string());
        }
        data.extend_from_slice(&chunk[..read]);
        if let Some(position) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = position + 4;
            break;
        }
        if data.len() > 64 * 1024 {
            return Err("浏览器桥接请求头过大".to_string());
        }
    }
    let header_text = String::from_utf8_lossy(&data[..header_end]).into_owned();
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut content_length = 0_usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    while data.len() < header_end.saturating_add(content_length) {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("浏览器桥接请求体不完整".to_string());
        }
        data.extend_from_slice(&chunk[..read]);
        if data.len() > 4 * 1024 * 1024 {
            return Err("浏览器桥接请求体过大".to_string());
        }
    }

    let (method, path) = request_line
        .split_once(' ')
        .and_then(|(method, rest)| rest.split_once(' ').map(|(path, _)| (method, path)))
        .unwrap_or_default();
    if method.eq_ignore_ascii_case("OPTIONS") {
        write_bridge_response(&mut stream, 204, "").await?;
        return Ok(());
    }
    if !method.eq_ignore_ascii_case("POST") || path != DOWNLOAD_BRIDGE_PATH {
        write_bridge_response(&mut stream, 404, "{\"accepted\":false}").await?;
        return Ok(());
    }
    write_bridge_response(&mut stream, 200, "{\"accepted\":false}").await?;
    Ok(())
}

#[cfg(feature = "tauri-app")]
async fn write_bridge_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

/// Routes protocol URLs received by either the deep-link plugin or the
/// single-instance plugin. Windows delivers URLs to the existing instance
/// through the latter when Skerry is already running.
#[cfg(feature = "tauri-app")]
pub fn dispatch_protocol_args(app: &tauri::AppHandle, args: &[String]) {
    for argument in args {
        let Ok(url) = Url::parse(argument) else {
            continue;
        };
        dispatch_protocol_url(app, url);
    }
}

#[cfg(feature = "tauri-app")]
fn dispatch_protocol_url(app: &tauri::AppHandle, url: Url) {
    if url.scheme() == INSTALL_SCHEME && url.host_str() == Some(INSTALL_HOST) {
        enqueue_install_url(app, url);
    }
}

#[cfg(feature = "tauri-app")]
fn current_executable_for_log() -> String {
    match tauri::utils::platform::current_exe() {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => format!("<获取失败: {error}>"),
    }
}

#[cfg(feature = "tauri-app")]
fn enqueue_install_url(app: &tauri::AppHandle, url: Url) {
    let state = app.state::<InstallProtocolState>();
    match parse_install_url(url) {
        Ok(request) => {
            if state.push_request(request) {
                let _ = app.emit("game-install-requested", ());
            }
        }
        Err(message) => {
            log::warn!("拒绝无效安装协议请求: {message}");
            state.push_rejection(message);
            let _ = app.emit("game-install-request-rejected", ());
        }
    }
}

pub fn parse_install_url(url: Url) -> Result<InstallRequest, String> {
    if url.scheme() != INSTALL_SCHEME || url.host_str() != Some(INSTALL_HOST) {
        return Err("协议地址必须是 skerry://install".to_string());
    }

    // Url::query_pairs 会逐个解码参数；不能预先解码整段 query，否则签名 URL 中的 & 会被拆开。
    let mut params = HashMap::new();
    for (key, value) in url.query_pairs() {
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("安装请求包含重复参数".to_string());
        }
    }

    if let Some(unknown) = params
        .keys()
        .find(|key| !SUPPORTED_REQUEST_PARAMS.contains(&key.as_str()))
    {
        return Err(format!("安装请求包含未知参数: {unknown}"));
    }

    let v = required_param(&params, "v")?
        .parse::<u32>()
        .map_err(|_| "v 无效".to_string())?;
    let provider = required_param(&params, "provider")?
        .trim()
        .to_ascii_lowercase();
    let file_name = required_param(&params, "file_name")?.trim().to_string();
    let checksum = required_param(&params, "checksum")?
        .trim()
        .to_ascii_lowercase();
    let resource_id = required_param(&params, "resource_id")?.trim().to_string();
    let bgm_id = match optional_param(&params, "bgm_id") {
        Some(value) => Some(non_empty_owned(value).ok_or_else(|| "bgm_id 不能为空".to_string())?),
        None => None,
    };
    let vndb_id = match optional_param(&params, "vndb_id") {
        Some(value) => Some(non_empty_owned(value).ok_or_else(|| "vndb_id 不能为空".to_string())?),
        None => None,
    };
    let hikarinagi_id = match optional_param(&params, "hikarinagi_id") {
        Some(value) => {
            Some(non_empty_owned(value).ok_or_else(|| "hikarinagi_id 不能为空".to_string())?)
        }
        None => None,
    };
    let title = required_param(&params, "title")?.trim().to_string();

    InstallRequest {
        v,
        provider,
        resource_id,
        url: required_param(&params, "url")?.trim().to_string(),
        file_name,
        archive_format: normalize_archive_format(required_param(&params, "archive_format")?),
        size: required_param(&params, "size")?
            .parse::<u64>()
            .map_err(|_| "size 无效".to_string())?,
        checksum_algo: required_param(&params, "checksum_algo")?
            .trim()
            .to_ascii_lowercase(),
        checksum,
        expires_at: optional_param(&params, "expires_at")
            .map(|value| {
                value
                    .parse::<i64>()
                    .map_err(|_| "expires_at 无效".to_string())
            })
            .transpose()?,
        bgm_id,
        vndb_id,
        hikarinagi_id,
        title,
    }
    .validate()
}

fn required_param<'a>(params: &'a HashMap<String, String>, name: &str) -> Result<&'a str, String> {
    optional_param(params, name).ok_or_else(|| format!("缺少参数: {name}"))
}

fn optional_param<'a>(params: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    params.get(name).map(String::as_str)
}

fn non_empty_owned(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn normalize_archive_format(value: &str) -> String {
    match value
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "tgz" => "tar.gz".to_string(),
        "tbz" | "tbz2" => "tar.bz2".to_string(),
        "txz" => "tar.xz".to_string(),
        "tzst" => "tar.zst".to_string(),
        value => value.to_string(),
    }
}

fn validate_identifier(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
    {
        return Err(format!("{name} 格式无效"));
    }
    Ok(())
}

fn validate_file_name(value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    let is_single_name = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !value.contains(['/', '\\', ':'])
        && !matches!(value.trim(), "" | "." | "..");
    is_single_name
        .then_some(())
        .ok_or_else(|| "file_name 必须是安全的单个文件名".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_query() -> String {
        "v=1&provider=shionlib&resource_id=42&file_name=game.7z&archive_format=7z&size=123&checksum_algo=sha256&checksum=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&expires_at=1999999999&bgm_id=123&vndb_id=v456&title=Game".to_string()
    }

    #[test]
    fn preserves_nested_signed_url() {
        let nested = "https%3A%2F%2Fcdn.example%2Ffile%3FX-Amz-Signature%3Dabc%26part%3D1";
        let url = Url::parse(&format!("skerry://install?{}&url={nested}", base_query())).unwrap();

        let request = parse_install_url(url).unwrap();
        assert_eq!(
            request.url,
            "https://cdn.example/file?X-Amz-Signature=abc&part=1"
        );
    }

    #[test]
    fn rejects_legacy_aliases_and_unknown_parameters() {
        let url = Url::parse(
            "skerry://install?v=1&provider=shionlib&resource_id=42&url=https%3A%2F%2Fexample.com%2Fgame.zip&file_name=game.zip&archive_format=zip&size=123&checksum_algo=blake3&checksum=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&expires_at=1999999999&bgm_id=789&title=Game&download_source=shionlib",
        )
        .unwrap();

        assert!(
            parse_install_url(url)
                .unwrap_err()
                .contains("未知参数: download_source")
        );
    }

    #[test]
    fn rejects_missing_required_parameters() {
        let url = Url::parse(
            "skerry://install?v=1&provider=shionlib&resource_id=42&url=https%3A%2F%2Fexample.com%2Fgame.zip&file_name=game.zip&archive_format=zip&size=123&checksum_algo=blake3&checksum=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap();

        assert!(
            parse_install_url(url)
                .unwrap_err()
                .contains("缺少参数: title")
        );
    }

    #[test]
    fn parses_request_without_metadata_ids_or_expiration() {
        let url = Url::parse(
            "skerry://install?v=1&provider=self-hosted&resource_id=42&url=http%3A%2F%2Flocalhost%3A8080%2Fgame.zip&file_name=game.zip&archive_format=zip&size=123&checksum_algo=blake3&checksum=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&title=Game",
        )
        .unwrap();

        let request = parse_install_url(url).unwrap();
        assert_eq!(request.expires_at, None);
        assert_eq!(request.bgm_id, None);
        assert_eq!(request.vndb_id, None);
        assert_eq!(request.hikarinagi_id, None);
    }

    #[test]
    fn parses_optional_hikarinagi_id() {
        let url = Url::parse(&format!(
            "skerry://install?{}&url=https%3A%2F%2Fexample.com%2Fgame.zip&hikarinagi_id=789",
            base_query()
        ))
        .unwrap();

        let request = parse_install_url(url).unwrap();
        assert_eq!(request.hikarinagi_id.as_deref(), Some("789"));
    }
}
