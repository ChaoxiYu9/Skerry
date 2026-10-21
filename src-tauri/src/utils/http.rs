use reqwest::{Client, NoProxy, Proxy};
use serde::Deserialize;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

const GLOBAL_USER_AGENT: &str = concat!(
    "Skerry/",
    env!("CARGO_PKG_VERSION"),
    " (local desktop build)"
);

const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 10;
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const LOCAL_PROXY_BYPASS: &str = "localhost,127.0.0.0/8,::1,0.0.0.0,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,fc00::/7,fe80::/10,.local";

#[derive(Debug, Clone, Deserialize)]
pub struct ProxyConfig {
    pub url: String,
}

struct HttpClientState {
    client: Client,
}

static GLOBAL_HTTP_CLIENT: OnceLock<RwLock<HttpClientState>> = OnceLock::new();

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn update_proxy_config(config: ProxyConfig) -> Result<(), String> {
    let proxy_url = config.url.trim();
    let client = build_client(proxy_url, true, true, false)?;
    let mut guard = http_client()
        .write()
        .map_err(|_| "更新 HTTP 客户端失败".to_string())?;
    *guard = HttpClientState { client };
    Ok(())
}

fn build_client(
    proxy_url: &str,
    request_timeout: bool,
    follow_redirects: bool,
    http1_only: bool,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS))
        .tcp_keepalive(Duration::from_secs(60))
        .tcp_nodelay(true)
        .pool_idle_timeout(Duration::from_secs(300))
        .pool_max_idle_per_host(256)
        .user_agent(GLOBAL_USER_AGENT);

    if http1_only {
        builder = builder.http1_only();
    }

    if request_timeout {
        builder = builder.timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS));
    }
    if !follow_redirects {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    if !proxy_url.is_empty() {
        let proxy = Proxy::all(proxy_url)
            .map_err(|e| format!("代理地址无效: {e}"))?
            .no_proxy(NoProxy::from_string(LOCAL_PROXY_BYPASS));
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

fn http_client() -> &'static RwLock<HttpClientState> {
    GLOBAL_HTTP_CLIENT.get_or_init(|| {
        RwLock::new(HttpClientState {
            client: build_client("", true, true, false)
                .expect("failed to build default http client"),
        })
    })
}

pub fn get_client() -> Client {
    http_client()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .client
        .clone()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AppUpdateProgress {
    pub received: u64,
    pub total: Option<u64>,
    pub percent: u32,
}

fn download_percent(received: u64, total: Option<u64>) -> u32 {
    let Some(total) = total.filter(|total| *total > 0) else {
        return 0;
    };
    let percent = (u128::from(received) * 100) / u128::from(total);
    u32::try_from(percent.min(100)).unwrap_or(100)
}

fn validate_update_file_name(file_name: &str) -> Result<&str, String> {
    use std::path::{Component, Path};

    if file_name.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
    }) || file_name.ends_with('.')
        || file_name.ends_with(' ')
    {
        return Err("更新文件名无效".to_string());
    }

    let mut components = Path::new(file_name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) if name == std::ffi::OsStr::new(file_name) => {
            Ok(file_name)
        }
        _ => Err("更新文件名无效".to_string()),
    }
}

fn normalize_update_sha256(value: &str) -> Result<String, String> {
    let digest = value.trim().strip_prefix("sha256:").unwrap_or(value.trim());
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("发布信息缺少有效的 SHA-256 摘要".to_string());
    }
    Ok(digest.to_ascii_lowercase())
}

async fn update_file_sha256(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("打开安装包以校验摘要失败: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("读取安装包以校验摘要失败: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn numbered_update_file_name(file_name: &str, number: usize) -> String {
    use std::path::Path;

    let path = Path::new(file_name);
    match (
        path.file_stem().and_then(std::ffi::OsStr::to_str),
        path.extension().and_then(std::ffi::OsStr::to_str),
    ) {
        (Some(stem), Some(extension)) => format!("{stem}_{number}.{extension}"),
        _ => format!("{file_name}_{number}"),
    }
}

async fn reserve_update_file(
    target_dir: &std::path::Path,
    file_name: &str,
) -> Result<(std::path::PathBuf, tokio::fs::File), String> {
    use tokio::fs::OpenOptions;

    let mut collision_number = None;
    loop {
        let candidate_name = match collision_number {
            Some(number) => numbered_update_file_name(file_name, number),
            None => file_name.to_string(),
        };
        let target_path = target_dir.join(candidate_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target_path)
            .await
        {
            Ok(file) => return Ok((target_path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                collision_number = Some(match collision_number {
                    Some(number) => number
                        .checked_add(1)
                        .ok_or_else(|| "更新文件名冲突次数超出支持范围".to_string())?,
                    None => 1,
                });
            }
            Err(error) => return Err(format!("创建安装包文件失败: {error}")),
        }
    }
}

async fn save_update_response<F>(
    mut response: reqwest::Response,
    target_dir: &std::path::Path,
    file_name: &str,
    mut report_progress: F,
) -> Result<std::path::PathBuf, String>
where
    F: FnMut(AppUpdateProgress),
{
    use tokio::io::AsyncWriteExt;

    let file_name = validate_update_file_name(file_name)?;
    let (target_path, mut file) = reserve_update_file(target_dir, file_name).await?;
    let write_result = async {
        let total_size = response.content_length();
        let mut received = 0_u64;

        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取下载数据流失败: {error}"))?
        {
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("写入数据失败: {error}"))?;
            let chunk_size =
                u64::try_from(chunk.len()).map_err(|_| "下载数据块大小超出支持范围".to_string())?;
            received = received
                .checked_add(chunk_size)
                .ok_or_else(|| "下载数据总大小超出支持范围".to_string())?;

            report_progress(AppUpdateProgress {
                received,
                total: total_size,
                percent: download_percent(received, total_size),
            });
        }

        file.flush()
            .await
            .map_err(|error| format!("保存安装包文件失败: {error}"))
    }
    .await;
    drop(file);

    match write_result {
        Ok(()) => Ok(target_path),
        Err(error) => match tokio::fs::remove_file(&target_path).await {
            Ok(()) => Err(error),
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {
                Err(error)
            }
            Err(cleanup_error) => Err(format!(
                "{error}; 无法清理未完成的安装包 {}: {cleanup_error}",
                target_path.display()
            )),
        },
    }
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn download_app_update(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
    expected_sha256: String,
) -> Result<String, String> {
    use tauri::Emitter;

    let file_name = validate_update_file_name(&file_name)?;
    let lower_name = file_name.to_ascii_lowercase();
    if !lower_name.ends_with("-setup.exe") && !lower_name.ends_with(".msi") {
        return Err("仅支持 Skerry NSIS 安装包（*-setup.exe）或 MSI 安装包".to_string());
    }
    let expected_sha256 = normalize_update_sha256(&expected_sha256)?;
    let parsed_url = reqwest::Url::parse(&url).map_err(|error| format!("更新地址无效: {error}"))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err("更新地址必须使用 HTTP 或 HTTPS".to_string());
    }
    let target_dir = std::env::temp_dir().join("skerry_updates");
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|error| format!("创建更新目录失败: {error}"))?;

    let client = get_client();

    // 优先尝试原下载地址，失败时尝试国内加速镜像
    let response = match client.get(&url).send().await {
        Ok(res) if res.status().is_success() => res,
        _ => {
            let mirror_url = format!("https://ghfast.top/{}", url);
            client
                .get(&mirror_url)
                .send()
                .await
                .map_err(|e| format!("下载安装包失败: {}", e))?
        }
    };

    if !response.status().is_success() {
        return Err(format!("下载请求失败，状态码: {}", response.status()));
    }

    let target_path = save_update_response(response, &target_dir, file_name, |progress| {
        let _ = app.emit("app-update-progress", progress);
    })
    .await?;

    let actual_sha256 = match update_file_sha256(&target_path).await {
        Ok(digest) => digest,
        Err(error) => {
            let _ = tokio::fs::remove_file(&target_path).await;
            return Err(error);
        }
    };
    if actual_sha256 != expected_sha256 {
        let cleanup = tokio::fs::remove_file(&target_path).await;
        let cleanup_note = cleanup
            .err()
            .map(|error| format!("；清理失败: {error}"))
            .unwrap_or_default();
        return Err(format!("安装包 SHA-256 校验失败{cleanup_note}"));
    }

    Ok(target_path.to_string_lossy().to_string())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn install_update_and_restart(
    app: tauri::AppHandle,
    installer_path: String,
    expected_sha256: String,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(&installer_path);
    if !path.is_file() {
        return Err("安装包文件不存在".to_string());
    }
    let expected_sha256 = normalize_update_sha256(&expected_sha256)?;
    let actual_sha256 = update_file_sha256(&path).await?;
    if actual_sha256 != expected_sha256 {
        return Err("安装包在下载后发生变化，SHA-256 校验失败".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use crate::utils::command_ext::CommandGuiExt;
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let application_path =
            std::env::current_exe().map_err(|error| format!("获取当前程序路径失败: {error}"))?;
        let script_path =
            std::env::temp_dir().join(format!("skerry_install_update_{}.ps1", std::process::id()));
        tokio::fs::write(
            &script_path,
            include_str!("../../scripts/install-update.ps1"),
        )
        .await
        .map_err(|error| format!("准备静默安装脚本失败: {error}"))?;

        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
            ])
            .arg(&script_path)
            .arg("-ParentProcessId")
            .arg(std::process::id().to_string())
            .arg("-InstallerPath")
            .arg(&path)
            .arg("-ApplicationPath")
            .arg(&application_path)
            .creation_flags(CREATE_NO_WINDOW)
            .gui_safe()
            .spawn()
            .map_err(|error| format!("启动静默更新助手失败: {error}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    return Err("静默安装和自动重启目前仅支持 Windows 安装包".to_string());

    // 更新助手先等待此进程退出，再启动安装包并在安装成功后重新打开当前路径。
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        AppUpdateProgress, download_percent, reserve_update_file, save_update_response,
        validate_update_file_name,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    static TEMP_DIRECTORY_ID: AtomicUsize = AtomicUsize::new(0);

    async fn test_directory() -> std::path::PathBuf {
        loop {
            let id = TEMP_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "skerry-update-http-test-{}-{id}",
                std::process::id()
            ));
            match tokio::fs::create_dir(&path).await {
                Ok(()) => return path,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create test directory: {error}"),
            }
        }
    }

    async fn response_server(
        body: &'static [u8],
        declared_length: usize,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 1024];
            let _ = stream.read(&mut request).await;
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(body).await.unwrap();
            stream.shutdown().await.unwrap();
        });
        (format!("http://{address}/setup.exe"), task)
    }

    #[test]
    fn accepts_one_plain_asset_name_and_rejects_paths() {
        assert_eq!(
            validate_update_file_name("Skerry-Setup.exe"),
            Ok("Skerry-Setup.exe")
        );
        for invalid in [
            "",
            ".",
            "..",
            "../setup.exe",
            r"..\setup.exe",
            r"C:\setup.exe",
            "dir/setup.exe",
            "setup.exe:payload",
            "bad?.exe",
            "trailing.",
            "trailing ",
        ] {
            assert!(validate_update_file_name(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn download_progress_is_bounded_and_unknown_lengths_remain_indeterminate() {
        assert_eq!(download_percent(25, Some(100)), 25);
        assert_eq!(download_percent(125, Some(100)), 100);
        assert_eq!(download_percent(25, None), 0);
        assert_eq!(download_percent(25, Some(0)), 0);
    }

    #[tokio::test]
    async fn existing_asset_is_preserved_and_collision_gets_a_distinct_name() {
        let directory = test_directory().await;
        let (first_path, mut first_file) = reserve_update_file(&directory, "Skerry-Setup.exe")
            .await
            .unwrap();
        first_file.write_all(b"existing installer").await.unwrap();
        first_file.flush().await.unwrap();

        let (second_path, mut second_file) = reserve_update_file(&directory, "Skerry-Setup.exe")
            .await
            .unwrap();
        second_file.write_all(b"new installer").await.unwrap();
        second_file.flush().await.unwrap();

        assert_eq!(
            first_path.file_name().unwrap(),
            std::ffi::OsStr::new("Skerry-Setup.exe")
        );
        assert_eq!(
            second_path.file_name().unwrap(),
            std::ffi::OsStr::new("Skerry-Setup_1.exe")
        );
        drop((first_file, second_file));
        assert_eq!(
            tokio::fs::read(&first_path).await.unwrap(),
            b"existing installer"
        );
        assert_eq!(
            tokio::fs::read(&second_path).await.unwrap(),
            b"new installer"
        );

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_downloads_of_the_same_asset_reserve_separate_files() {
        let directory = test_directory().await;
        let reserve = |contents: &'static [u8]| async {
            let (path, mut file) = reserve_update_file(&directory, "Skerry-Setup.exe")
                .await
                .unwrap();
            file.write_all(contents).await.unwrap();
            file.flush().await.unwrap();
            drop(file);
            path
        };

        let (first_path, second_path) = tokio::join!(reserve(b"first"), reserve(b"second"));
        assert_ne!(first_path, second_path);
        let first_contents = tokio::fs::read(&first_path).await.unwrap();
        let second_contents = tokio::fs::read(&second_path).await.unwrap();
        assert_ne!(first_contents, second_contents);
        assert!(
            [first_contents.as_slice(), second_contents.as_slice()].contains(&b"first".as_slice())
        );
        assert!(
            [first_contents.as_slice(), second_contents.as_slice()].contains(&b"second".as_slice())
        );

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn truncated_response_removes_partial_installer_and_allows_retry() {
        let directory = test_directory().await;
        let (url, server) = response_server(b"partial", 64).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client.get(url).send().await.unwrap();
        let result = save_update_response(response, &directory, "Skerry-Setup.exe", |_| {}).await;
        server.await.unwrap();

        assert!(
            result.unwrap_err().starts_with("读取下载数据流失败:"),
            "truncated response should report its read failure"
        );
        assert!(
            tokio::fs::read_dir(&directory)
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_none()
        );

        let (url, server) = response_server(b"complete installer", 18).await;
        let response = client.get(url).send().await.unwrap();
        let mut progress = Vec::<AppUpdateProgress>::new();
        let result = save_update_response(response, &directory, "Skerry-Setup.exe", |event| {
            progress.push(event);
        })
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(result.file_name().unwrap(), "Skerry-Setup.exe");
        assert_eq!(
            tokio::fs::read(&result).await.unwrap(),
            b"complete installer"
        );
        assert_eq!(progress.last().unwrap().received, 18);
        assert_eq!(progress.last().unwrap().total, Some(18));
        assert_eq!(progress.last().unwrap().percent, 100);

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
