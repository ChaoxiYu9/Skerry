use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

/// OAuth 回调事件载荷。PKCE verifier 只在本地回调线程和前端之间传递，不写入数据库。
#[derive(Clone, Debug, Serialize)]
pub struct OAuthCallbackPayload {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_verifier: Option<String>,
}

type OAuthServerRegistry = HashMap<u16, Arc<OAuthCallbackServer>>;
type OAuthCallbackRegistry = HashMap<String, Arc<OAuthCallbackRegistration>>;

static OAUTH_SERVERS: OnceLock<Mutex<OAuthServerRegistry>> = OnceLock::new();

fn oauth_servers() -> &'static Mutex<OAuthServerRegistry> {
    OAUTH_SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct OAuthCallbackServer {
    callbacks: Mutex<OAuthCallbackRegistry>,
}

struct OAuthCallbackRegistration {
    app: AppHandle,
    event_prefix: String,
    callback_path: String,
    expected_state: String,
    code_verifier: Option<String>,
    deadline: Instant,
    cancellation: Arc<AtomicBool>,
    completed: AtomicBool,
}

/// 生成不可预测的 OAuth state。
pub fn generate_oauth_state() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("生成 OAuth state 失败: {error}"))?;

    let mut state = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut state, "{byte:02x}")
            .map_err(|error| format!("生成 OAuth state 失败: {error}"))?;
    }

    Ok(state)
}

/// 生成 OAuth 2.0 PKCE S256 所需的 verifier 和 challenge。
pub fn generate_pkce_pair() -> Result<(String, String), String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("生成 PKCE verifier 失败: {error}"))?;
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    Ok((verifier, challenge))
}

/// 启动一次本地 OAuth 回调，并通过 Tauri 事件返回授权码。
///
/// 同一个端口只会绑定一个监听器，各 OAuth 提供方通过回调路径独立注册和分发。
pub fn start_oauth_callback(
    app: AppHandle,
    event_prefix: &str,
    callback_port: u16,
    callback_path: &str,
    timeout: Duration,
    expected_state: String,
    code_verifier: Option<String>,
) -> Result<(), String> {
    let server = ensure_oauth_server(callback_port)?;
    expire_oauth_callbacks(&server);

    let registration = Arc::new(OAuthCallbackRegistration {
        app,
        event_prefix: event_prefix.to_string(),
        callback_path: callback_path.to_string(),
        expected_state,
        code_verifier,
        deadline: Instant::now() + timeout,
        cancellation: Arc::new(AtomicBool::new(false)),
        completed: AtomicBool::new(false),
    });

    let mut callbacks = server
        .callbacks
        .lock()
        .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?;
    if callbacks
        .get(callback_path)
        .is_some_and(|active| !active.cancellation.load(Ordering::Acquire))
    {
        return Err("该 OAuth 回调路径正在等待授权，请先取消当前登录".to_string());
    }
    callbacks.insert(callback_path.to_string(), registration);

    Ok(())
}

/// 取消指定端口和回调路径上的 OAuth 等待。
pub fn cancel_oauth_callback(callback_port: u16, callback_path: &str) -> Result<(), String> {
    let server = {
        let servers = oauth_servers()
            .lock()
            .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?;
        servers.get(&callback_port).cloned()
    };

    let Some(server) = server else {
        return Ok(());
    };

    let registration = server
        .callbacks
        .lock()
        .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?
        .remove(callback_path);
    if let Some(registration) = registration {
        registration.cancellation.store(true, Ordering::Release);
    }

    Ok(())
}

fn ensure_oauth_server(callback_port: u16) -> Result<Arc<OAuthCallbackServer>, String> {
    let mut servers = oauth_servers()
        .lock()
        .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?;
    if let Some(server) = servers.get(&callback_port) {
        return Ok(server.clone());
    }

    let listener = TcpListener::bind(("127.0.0.1", callback_port)).map_err(|error| {
        format!("启动 OAuth 回调服务失败（端口 {callback_port} 可能被占用）: {error}")
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("设置 OAuth 回调监听失败: {error}"))?;

    let server = Arc::new(OAuthCallbackServer {
        callbacks: Mutex::new(HashMap::new()),
    });
    servers.insert(callback_port, server.clone());

    let listener_server = server.clone();
    std::thread::spawn(move || run_oauth_listener(listener, callback_port, listener_server));

    Ok(server)
}

fn run_oauth_listener(listener: TcpListener, callback_port: u16, server: Arc<OAuthCallbackServer>) {
    loop {
        expire_oauth_callbacks(&server);

        match listener.accept() {
            Ok((stream, _)) => {
                let connection_server = server.clone();
                std::thread::spawn(move || {
                    handle_oauth_connection(stream, callback_port, connection_server);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                let message = format!("OAuth 回调监听失败: {error}");
                fail_oauth_callbacks(&server, &message);
                remove_oauth_server(callback_port, &server);
                log::warn!("{message}");
                break;
            }
        }
    }
}

fn handle_oauth_connection(
    mut stream: TcpStream,
    callback_port: u16,
    server: Arc<OAuthCallbackServer>,
) {
    let query = match parse_callback(&mut stream, callback_port) {
        Ok(query) => query,
        Err(message) => {
            let result = Err(message.clone());
            write_callback_response(&mut stream, &result);
            log::warn!("OAuth 回调失败: {message}");
            return;
        }
    };

    let registration = match server.callbacks.lock() {
        Ok(callbacks) => callbacks.get(&query.path).cloned(),
        Err(_) => {
            let result = Err("OAuth 回调状态锁已损坏".to_string());
            write_callback_response(&mut stream, &result);
            log::warn!("OAuth 回调失败: OAuth 回调状态锁已损坏");
            return;
        }
    };

    let Some(registration) = registration else {
        let result = Err("OAuth 回调路径不匹配，请重新登录".to_string());
        write_callback_response(&mut stream, &result);
        return;
    };

    let result = if registration.cancellation.load(Ordering::Acquire)
        || registration.completed.swap(true, Ordering::AcqRel)
    {
        Ok(None)
    } else {
        validate_callback(query, &registration.expected_state).map(Some)
    };
    write_callback_response(&mut stream, &result);
    remove_oauth_callback_if_same(&server, &registration);

    if registration.cancellation.load(Ordering::Acquire) {
        return;
    }

    match result {
        Ok(Some(code)) => {
            let payload = OAuthCallbackPayload {
                code,
                code_verifier: registration.code_verifier.clone(),
            };
            if let Err(error) = registration.app.emit(
                &format!("{}-oauth-code", registration.event_prefix),
                &payload,
            ) {
                log::warn!("发送 OAuth code 事件失败: {error}");
            }
        }
        Ok(None) => {}
        Err(message) => {
            log::warn!("OAuth 回调失败: {message}");
            if let Err(error) = registration.app.emit(
                &format!("{}-oauth-error", registration.event_prefix),
                &message,
            ) {
                log::warn!("发送 OAuth error 事件失败: {error}");
            }
        }
    }
}

fn validate_callback(query: OAuthCallbackQuery, expected_state: &str) -> Result<String, String> {
    if let Some(error) = query.error {
        let detail = query.error_description.unwrap_or_default();
        return Err(if detail.is_empty() {
            format!("OAuth 授权失败: {error}")
        } else {
            format!("OAuth 授权失败: {error}（{detail}）")
        });
    }

    if query.state.as_deref() != Some(expected_state) {
        return Err("OAuth state 校验失败，请重新登录".to_string());
    }

    query
        .code
        .filter(|code| !code.is_empty())
        .ok_or_else(|| "OAuth 回调缺少授权码".to_string())
}

fn expire_oauth_callbacks(server: &OAuthCallbackServer) {
    let now = Instant::now();
    let mut timed_out = Vec::new();
    let mut callbacks = match server.callbacks.lock() {
        Ok(callbacks) => callbacks,
        Err(_) => {
            log::warn!("OAuth 回调状态锁已损坏");
            return;
        }
    };

    callbacks.retain(|_, registration| {
        if registration.cancellation.load(Ordering::Acquire) {
            return false;
        }
        if registration.deadline > now {
            return true;
        }

        registration.cancellation.store(true, Ordering::Release);
        if !registration.completed.swap(true, Ordering::AcqRel) {
            timed_out.push(registration.clone());
        }
        false
    });
    drop(callbacks);

    for registration in timed_out {
        emit_oauth_error(&registration, "OAuth 回调等待超时，请重新登录");
    }
}

fn fail_oauth_callbacks(server: &OAuthCallbackServer, message: &str) {
    let registrations = match server.callbacks.lock() {
        Ok(mut callbacks) => callbacks
            .drain()
            .map(|(_, registration)| {
                registration.cancellation.store(true, Ordering::Release);
                registration
            })
            .collect::<Vec<_>>(),
        Err(_) => {
            log::warn!("OAuth 回调状态锁已损坏");
            return;
        }
    };

    for registration in registrations {
        if !registration.completed.swap(true, Ordering::AcqRel) {
            emit_oauth_error(&registration, message);
        }
    }
}

fn emit_oauth_error(registration: &OAuthCallbackRegistration, message: &str) {
    if let Err(error) = registration.app.emit(
        &format!("{}-oauth-error", registration.event_prefix),
        &message,
    ) {
        log::warn!("发送 OAuth error 事件失败: {error}");
    }
}

fn remove_oauth_server(callback_port: u16, server: &OAuthCallbackServer) {
    if let Ok(mut servers) = oauth_servers().lock()
        && servers
            .get(&callback_port)
            .is_some_and(|active| std::ptr::eq(active.as_ref(), server))
    {
        servers.remove(&callback_port);
    }
}

fn remove_oauth_callback_if_same(
    server: &OAuthCallbackServer,
    registration: &Arc<OAuthCallbackRegistration>,
) {
    if let Ok(mut callbacks) = server.callbacks.lock()
        && callbacks
            .get(&registration.callback_path)
            .is_some_and(|active| Arc::ptr_eq(active, registration))
    {
        callbacks.remove(&registration.callback_path);
    }
}

fn write_callback_response(stream: &mut TcpStream, result: &Result<Option<String>, String>) {
    let body = match result {
        Ok(Some(_)) => "<html><body><h1>授权成功</h1><p>你可以关闭此页面。</p></body></html>",
        Ok(None) => "<html><body><h1>授权已取消</h1><p>可以关闭此页面了。</p></body></html>",
        Err(_) => "<html><body><h1>授权失败</h1><p>请返回应用重试。</p></body></html>",
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

#[derive(Default)]
struct OAuthCallbackQuery {
    path: String,
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

fn parse_callback(
    stream: &mut TcpStream,
    callback_port: u16,
) -> Result<OAuthCallbackQuery, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| format!("读取 OAuth 回调失败: {error}"))?;
    stream
        .set_nonblocking(false)
        .map_err(|error| format!("读取 OAuth 回调失败: {error}"))?;
    let reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("读取 OAuth 回调失败: {error}"))?,
    );
    let request_line = reader
        .lines()
        .next()
        .ok_or_else(|| "OAuth 回调请求为空".to_string())?
        .map_err(|error| format!("读取 OAuth 回调请求失败: {error}"))?;
    let path = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "OAuth 回调请求格式无效".to_string())?;
    let callback_url = format!("http://127.0.0.1:{callback_port}{path}");
    let parsed = url::Url::parse(&callback_url)
        .map_err(|error| format!("解析 OAuth 回调参数失败: {error}"))?;

    let mut query = OAuthCallbackQuery {
        path: parsed.path().to_string(),
        ..Default::default()
    };
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "code" => query.code = Some(value.into_owned()),
            "state" => query.state = Some(value.into_owned()),
            "error" => query.error = Some(value.into_owned()),
            "error_description" => query.error_description = Some(value.into_owned()),
            _ => {}
        }
    }

    Ok(query)
}
