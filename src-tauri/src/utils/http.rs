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
    proxy_url: String,
}

static GLOBAL_HTTP_CLIENT: OnceLock<RwLock<HttpClientState>> = OnceLock::new();

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub fn update_proxy_config(config: ProxyConfig) -> Result<(), String> {
    let proxy_url = config.url.trim();
    let client = build_client(proxy_url, true, true, false)?;
    let mut guard = http_client()
        .write()
        .map_err(|_| "更新 HTTP 客户端失败".to_string())?;
    *guard = HttpClientState {
        client,
        proxy_url: proxy_url.to_string(),
    };
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
            proxy_url: String::new(),
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

/// 下载大型文件时不设置总请求超时，并禁用自动重定向以便调用方逐跳校验地址。
pub fn get_download_client() -> Result<Client, String> {
    let proxy_url = http_client()
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .proxy_url
        .clone();
    build_client(&proxy_url, false, false, true)
}


#[derive(Debug, Clone, serde::Serialize)]
pub struct AppUpdateProgress {
    pub received: u64,
    pub total: Option<u64>,
    pub percent: u32,
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn download_app_update(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
) -> Result<String, String> {
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;

    let target_dir = std::env::temp_dir().join("skerry_updates");
    if !target_dir.exists() {
        tokio::fs::create_dir_all(&target_dir)
            .await
            .map_err(|e| format!("创建更新目录失败: {}", e))?;
    }
    let target_path = target_dir.join(&file_name);

    let client = get_client();

    // 优先尝试原下载地址，失败时尝试国内加速镜像
    let mut response = match client.get(&url).send().await {
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

    let total_size = response.content_length();
    let mut file = tokio::fs::File::create(&target_path)
        .await
        .map_err(|e| format!("创建安装包文件失败: {}", e))?;

    let mut received: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取下载数据流失败: {}", e))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入数据失败: {}", e))?;
        received += chunk.len() as u64;

        let percent = match total_size {
            Some(total) if total > 0 => (received as f64 / total as f64 * 100.0) as u32,
            _ => 0,
        };

        let _ = app.emit(
            "app-update-progress",
            AppUpdateProgress {
                received,
                total: total_size,
                percent,
            },
        );
    }

    file.flush()
        .await
        .map_err(|e| format!("保存安装包文件失败: {}", e))?;

    Ok(target_path.to_string_lossy().to_string())
}

#[cfg_attr(feature = "tauri-app", tauri::command)]
pub async fn launch_installer_and_exit(
    app: tauri::AppHandle,
    installer_path: String,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(&installer_path);
    if !path.is_file() {
        return Err("安装包文件不存在".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use crate::utils::command_ext::CommandGuiExt;
        Command::new(&path)
            .gui_safe()
            .spawn()
            .map_err(|e| format!("启动安装程序失败: {}", e))?;
    }

    // 延迟 300ms 后安全退出当前 Skerry 实例，避免与安装包产生文件占用冲突
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    app.exit(0);
    Ok(())
}
