use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

/// OAuth 回调事件载荷。PKCE verifier 只在本地回调线程和前端之间传递，不写入数据库。
#[derive(Clone, Debug, Serialize)]
pub struct OAuthCallbackPayload {
    pub session_id: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_verifier: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OAuthCallbackErrorPayload {
    pub session_id: String,
    pub message: String,
}

type OAuthServerRegistry = HashMap<u16, Arc<OAuthCallbackServer>>;
type OAuthCallbackRegistry = CallbackTable<Arc<OAuthCallbackRegistration>>;

static OAUTH_SERVERS: OnceLock<Mutex<OAuthServerRegistry>> = OnceLock::new();

fn oauth_servers() -> &'static Mutex<OAuthServerRegistry> {
    OAUTH_SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct OAuthCallbackServer {
    state: Mutex<OAuthCallbackServerState>,
}

struct OAuthCallbackServerState {
    listener: OAuthListenerState,
    callbacks: OAuthCallbackRegistry,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OAuthListenerState {
    Listening,
    Failed,
}

impl OAuthCallbackServerState {
    fn new() -> Self {
        Self {
            listener: OAuthListenerState::Listening,
            callbacks: CallbackTable::default(),
        }
    }

    fn register(
        &mut self,
        callback_path: String,
        registration: OAuthCallbackEntry<Arc<OAuthCallbackRegistration>>,
    ) -> Result<(), String> {
        self.listener
            .register(&mut self.callbacks, callback_path, registration)
    }

    fn claim(&mut self, callback_path: &str) -> OAuthCallbackClaim<Arc<OAuthCallbackRegistration>> {
        self.callbacks.claim(callback_path)
    }

    fn cancel(&mut self, callback_path: &str, session_id: &str) -> bool {
        self.callbacks.cancel(callback_path, session_id)
    }

    fn expire(&mut self, now: Instant) -> Vec<(String, Arc<OAuthCallbackRegistration>)> {
        self.callbacks
            .expire(now, |registration| registration.deadline)
    }

    fn fail_listener(&mut self) -> Vec<(String, Arc<OAuthCallbackRegistration>)> {
        self.listener.fail();
        self.callbacks.fail_waiting()
    }

    fn is_listening(&self) -> bool {
        self.listener == OAuthListenerState::Listening
    }
}

impl OAuthListenerState {
    fn fail(&mut self) {
        *self = Self::Failed;
    }

    fn register<T: Clone>(
        self,
        callbacks: &mut CallbackTable<T>,
        callback_path: String,
        registration: OAuthCallbackEntry<T>,
    ) -> Result<(), String> {
        if self == Self::Failed {
            return Err("OAuth 回调服务不可用，请重新尝试登录".to_string());
        }
        callbacks.insert(callback_path, registration)
    }
}

struct OAuthCallbackRegistration {
    app: AppHandle,
    event_prefix: String,
    callback_path: String,
    expected_state: String,
    code_verifier: Option<String>,
    deadline: Instant,
}

// The callback registry owns the transition; removal from the registry is terminal.
#[derive(Clone, Copy, PartialEq, Eq)]
enum OAuthCallbackPhase {
    Waiting,
    Processing,
}

struct OAuthCallbackEntry<T> {
    session_id: String,
    registration: T,
    phase: OAuthCallbackPhase,
}

struct CallbackTable<T> {
    entries: HashMap<String, OAuthCallbackEntry<T>>,
}

impl<T> Default for CallbackTable<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<T: Clone> CallbackTable<T> {
    fn insert(
        &mut self,
        callback_path: String,
        entry: OAuthCallbackEntry<T>,
    ) -> Result<(), String> {
        if self.entries.contains_key(&callback_path) {
            return Err("该 OAuth 回调路径正在等待授权，请先取消当前登录".to_string());
        }
        self.entries.insert(callback_path, entry);
        Ok(())
    }

    fn claim(&mut self, callback_path: &str) -> OAuthCallbackClaim<T> {
        match self.entries.get_mut(callback_path) {
            Some(entry) => entry.claim().map_or(
                OAuthCallbackClaim::AlreadyProcessing,
                |(session_id, registration)| OAuthCallbackClaim::First {
                    session_id,
                    registration,
                },
            ),
            None => OAuthCallbackClaim::Missing,
        }
    }

    fn cancel(&mut self, callback_path: &str, session_id: &str) -> bool {
        if self
            .entries
            .get(callback_path)
            .is_some_and(|entry| entry.session_id == session_id)
        {
            self.entries.remove(callback_path);
            return true;
        }
        false
    }

    fn expire(&mut self, now: Instant, deadline_for: impl Fn(&T) -> Instant) -> Vec<(String, T)> {
        let mut expired = Vec::new();
        self.entries.retain(|_, entry| {
            if !entry.should_expire(deadline_for(&entry.registration), now) {
                return true;
            }
            expired.push((entry.session_id.clone(), entry.registration.clone()));
            false
        });
        expired
    }

    fn fail_waiting(&mut self) -> Vec<(String, T)> {
        let mut failed = Vec::new();
        self.entries.retain(|_, entry| {
            if !entry.should_report_terminal_failure() {
                return true;
            }
            failed.push((entry.session_id.clone(), entry.registration.clone()));
            false
        });
        failed
    }
}

impl<T: Clone> OAuthCallbackEntry<T> {
    fn waiting(session_id: String, registration: T) -> Self {
        Self {
            session_id,
            registration,
            phase: OAuthCallbackPhase::Waiting,
        }
    }

    fn claim(&mut self) -> Option<(String, T)> {
        if self.phase != OAuthCallbackPhase::Waiting {
            return None;
        }

        self.phase = OAuthCallbackPhase::Processing;
        Some((self.session_id.clone(), self.registration.clone()))
    }

    fn should_report_terminal_failure(&self) -> bool {
        self.phase == OAuthCallbackPhase::Waiting
    }

    // The deadline ends the wait; a claimed callback is not a timeout failure.
    fn should_expire(&self, deadline: Instant, now: Instant) -> bool {
        self.should_report_terminal_failure() && deadline <= now
    }
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

pub fn validate_access_token(provider: &str, access_token: &str) -> Result<(), String> {
    if access_token.trim().is_empty() {
        return Err(format!("{provider} OAuth 响应缺少 access_token"));
    }
    Ok(())
}

pub fn calculate_oauth_expires_at(
    provider: &str,
    now_unix_seconds: i64,
    expires_in_seconds: i64,
) -> Result<i64, String> {
    now_unix_seconds
        .checked_add(expires_in_seconds)
        .ok_or_else(|| format!("{provider} OAuth expires_in 超出可表示范围"))
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
    session_id: String,
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
    });

    let mut state = server
        .state
        .lock()
        .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?;
    state.register(
        callback_path.to_string(),
        OAuthCallbackEntry::waiting(session_id, registration),
    )?;

    Ok(())
}

/// 取消指定端口和回调路径上的 OAuth 等待。
pub fn cancel_oauth_callback(
    callback_port: u16,
    callback_path: &str,
    session_id: &str,
) -> Result<(), String> {
    let server = {
        let servers = oauth_servers()
            .lock()
            .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?;
        servers.get(&callback_port).cloned()
    };

    let Some(server) = server else {
        return Ok(());
    };

    let mut state = server
        .state
        .lock()
        .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?;
    state.cancel(callback_path, session_id);

    Ok(())
}

fn ensure_oauth_server(callback_port: u16) -> Result<Arc<OAuthCallbackServer>, String> {
    let mut servers = oauth_servers()
        .lock()
        .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?;
    if let Some(server) = servers.get(&callback_port).cloned() {
        let state = server
            .state
            .lock()
            .map_err(|_| "OAuth 回调状态锁已损坏".to_string())?;
        if state.is_listening() {
            return Ok(server.clone());
        }
        drop(state);
        servers.remove(&callback_port);
    }

    let listener = TcpListener::bind(("127.0.0.1", callback_port)).map_err(|error| {
        format!("启动 OAuth 回调服务失败（端口 {callback_port} 可能被占用）: {error}")
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("设置 OAuth 回调监听失败: {error}"))?;

    let server = Arc::new(OAuthCallbackServer {
        state: Mutex::new(OAuthCallbackServerState::new()),
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

    let claim = match server.state.lock() {
        Ok(mut state) => state.claim(&query.path),
        Err(_) => {
            let result = Err("OAuth 回调状态锁已损坏".to_string());
            write_callback_response(&mut stream, &result);
            log::warn!("OAuth 回调失败: OAuth 回调状态锁已损坏");
            return;
        }
    };

    let (session_id, registration) = match claim {
        OAuthCallbackClaim::First {
            session_id,
            registration,
        } => (session_id, registration),
        OAuthCallbackClaim::AlreadyProcessing => {
            write_callback_response(&mut stream, &Ok(None));
            return;
        }
        OAuthCallbackClaim::Missing => {
            let result = Err("OAuth 回调路径不匹配，请重新登录".to_string());
            write_callback_response(&mut stream, &result);
            return;
        }
    };

    let result = validate_callback(query, &registration.expected_state).map(Some);
    write_callback_response(&mut stream, &result);
    if !remove_oauth_callback_if_same(&server, &registration) {
        return;
    }

    match result {
        Ok(Some(code)) => {
            let payload = OAuthCallbackPayload {
                session_id,
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
            let payload = OAuthCallbackErrorPayload {
                session_id,
                message,
            };
            if let Err(error) = registration.app.emit(
                &format!("{}-oauth-error", registration.event_prefix),
                &payload,
            ) {
                log::warn!("发送 OAuth error 事件失败: {error}");
            }
        }
    }
}

fn validate_callback(query: OAuthCallbackQuery, expected_state: &str) -> Result<String, String> {
    if query.state.as_deref() != Some(expected_state) {
        return Err("OAuth state 校验失败，请重新登录".to_string());
    }

    if let Some(error) = query.error {
        return Err(match error.as_str() {
            "access_denied" => "用户取消了 OAuth 授权".to_string(),
            "invalid_scope" => "OAuth 授权范围无效，请检查应用权限".to_string(),
            _ => "OAuth 授权失败，请重试".to_string(),
        });
    }

    query
        .code
        .filter(|code| !code.is_empty())
        .ok_or_else(|| "OAuth 回调缺少授权码".to_string())
}

enum OAuthCallbackClaim<T> {
    First { session_id: String, registration: T },
    AlreadyProcessing,
    Missing,
}

#[cfg(test)]
mod callback_contract_tests {
    use super::{
        CallbackTable, OAuthCallbackEntry, OAuthCallbackQuery, OAuthListenerState,
        calculate_oauth_expires_at, parse_callback_target, validate_access_token,
        validate_callback,
    };
    use std::collections::HashMap;

    #[test]
    fn token_validation_rejects_empty_values_and_preserves_valid_tokens() {
        assert_eq!(
            validate_access_token("BGM", " "),
            Err("BGM OAuth 响应缺少 access_token".to_string())
        );
        assert_eq!(validate_access_token("BGM", "token-value"), Ok(()));
    }

    #[test]
    fn token_expiry_uses_unix_seconds_and_rejects_overflow() {
        assert_eq!(
            calculate_oauth_expires_at("BGM", 1_800_000_000, 3600),
            Ok(1_800_003_600)
        );
        assert_eq!(
            calculate_oauth_expires_at("BGM", i64::MAX, 1),
            Err("BGM OAuth expires_in 超出可表示范围".to_string())
        );
        assert_eq!(calculate_oauth_expires_at("BGM", 10, 0), Ok(10));
    }

    #[test]
    fn only_the_first_request_claims_a_callback_registration() {
        let mut entry = OAuthCallbackEntry::waiting("session-a".to_string(), "attempt".to_string());

        assert_eq!(
            entry.claim(),
            Some(("session-a".to_string(), "attempt".to_string()))
        );
        assert!(entry.claim().is_none());
        assert!(!entry.should_report_terminal_failure());
    }

    #[test]
    fn pending_registration_reports_timeout_or_listener_failure() {
        let entry = OAuthCallbackEntry::waiting("session-a".to_string(), "attempt".to_string());
        assert!(entry.should_report_terminal_failure());
        let now = std::time::Instant::now();
        assert!(entry.should_expire(now - std::time::Duration::from_secs(1), now));
    }

    #[test]
    fn expired_waiting_callbacks_are_removed_while_claimed_callbacks_finish() {
        #[derive(Clone)]
        struct TestRegistration {
            deadline: std::time::Instant,
        }

        let now = std::time::Instant::now();
        let expired_deadline = now - std::time::Duration::from_secs(1);
        let mut claimed = OAuthCallbackEntry::waiting(
            "session-processing".to_string(),
            TestRegistration {
                deadline: expired_deadline,
            },
        );
        assert!(claimed.claim().is_some());
        let mut callbacks = CallbackTable {
            entries: HashMap::from([
                (
                    "/waiting".to_string(),
                    OAuthCallbackEntry::waiting(
                        "session-waiting".to_string(),
                        TestRegistration {
                            deadline: expired_deadline,
                        },
                    ),
                ),
                ("/processing".to_string(), claimed),
            ]),
        };

        let timed_out = callbacks.expire(now, |registration| registration.deadline);

        assert_eq!(timed_out.len(), 1);
        assert_eq!(timed_out[0].0, "session-waiting");
        assert_eq!(callbacks.entries.len(), 1);
        assert!(callbacks.entries.contains_key("/processing"));
    }

    #[test]
    fn listener_failure_reports_waiting_callbacks_without_discarding_claimed_ones() {
        let mut claimed = OAuthCallbackEntry::waiting(
            "session-processing".to_string(),
            "processing-registration".to_string(),
        );
        assert!(claimed.claim().is_some());
        let mut callbacks = CallbackTable {
            entries: HashMap::from([
                (
                    "/waiting".to_string(),
                    OAuthCallbackEntry::waiting(
                        "session-waiting".to_string(),
                        "waiting-registration".to_string(),
                    ),
                ),
                ("/processing".to_string(), claimed),
            ]),
        };

        let failed = callbacks.fail_waiting();

        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, "session-waiting");
        assert_eq!(callbacks.entries.len(), 1);
        assert!(callbacks.entries.contains_key("/processing"));
    }

    #[test]
    fn failed_listener_cannot_accept_a_registration_for_an_orphaned_server() {
        let mut listener = OAuthListenerState::Listening;
        let mut callbacks = CallbackTable::<String>::default();
        listener
            .register(
                &mut callbacks,
                "/existing".to_string(),
                OAuthCallbackEntry::waiting("session-a".to_string(), "registration-a".to_string()),
            )
            .expect("active listener should accept its first registration");

        listener.fail();
        assert_eq!(
            listener.register(
                &mut callbacks,
                "/new".to_string(),
                OAuthCallbackEntry::waiting("session-b".to_string(), "registration-b".to_string()),
            ),
            Err("OAuth 回调服务不可用，请重新尝试登录".to_string())
        );
        assert_eq!(callbacks.entries.len(), 1);
        assert!(callbacks.entries.contains_key("/existing"));
    }

    #[test]
    fn stale_cancel_cannot_remove_a_different_sessions_registration() {
        let mut callbacks = CallbackTable::<String>::default();
        callbacks
            .insert(
                "/callback".to_string(),
                OAuthCallbackEntry::waiting("session-b".to_string(), "registration-b".to_string()),
            )
            .expect("callback route should be registered");

        assert!(!callbacks.cancel("/callback", "session-a"));
        assert_eq!(callbacks.entries.len(), 1);
        assert!(callbacks.cancel("/callback", "session-b"));
        assert!(callbacks.entries.is_empty());
    }

    #[test]
    fn callback_state_is_checked_before_provider_error_details() {
        let query = OAuthCallbackQuery {
            state: Some("wrong".to_string()),
            error: Some("access_denied".to_string()),
            ..OAuthCallbackQuery::default()
        };

        assert_eq!(
            validate_callback(query, "expected").unwrap_err(),
            "OAuth state 校验失败，请重新登录"
        );
    }

    #[test]
    fn callback_parser_does_not_retain_remote_error_descriptions() {
        let query = parse_callback_target(
            23380,
            "/callback?state=expected&error=access_denied&error_description=private%20detail",
        )
        .unwrap();

        assert_eq!(query.path, "/callback");
        assert_eq!(
            validate_callback(query, "expected").unwrap_err(),
            "用户取消了 OAuth 授权"
        );
    }

    #[test]
    fn provider_errors_use_fixed_messages_and_success_keeps_the_code() {
        let denied = OAuthCallbackQuery {
            state: Some("expected".to_string()),
            error: Some("access_denied".to_string()),
            ..OAuthCallbackQuery::default()
        };
        assert_eq!(
            validate_callback(denied, "expected").unwrap_err(),
            "用户取消了 OAuth 授权"
        );

        let unknown = OAuthCallbackQuery {
            state: Some("expected".to_string()),
            error: Some("remote-internal-detail".to_string()),
            ..OAuthCallbackQuery::default()
        };
        assert_eq!(
            validate_callback(unknown, "expected").unwrap_err(),
            "OAuth 授权失败，请重试"
        );

        let success = OAuthCallbackQuery {
            state: Some("expected".to_string()),
            code: Some("authorization-code".to_string()),
            ..OAuthCallbackQuery::default()
        };
        assert_eq!(
            validate_callback(success, "expected").unwrap(),
            "authorization-code"
        );
    }
}

fn expire_oauth_callbacks(server: &OAuthCallbackServer) {
    let now = Instant::now();
    let mut state = match server.state.lock() {
        Ok(state) => state,
        Err(_) => {
            log::warn!("OAuth 回调状态锁已损坏");
            return;
        }
    };
    let timed_out = state.expire(now);
    drop(state);

    for (session_id, registration) in timed_out {
        emit_oauth_error(&registration, &session_id, "OAuth 回调等待超时，请重新登录");
    }
}

fn fail_oauth_callbacks(server: &OAuthCallbackServer, message: &str) {
    let registrations = match server.state.lock() {
        Ok(mut state) => state.fail_listener(),
        Err(_) => {
            log::warn!("OAuth 回调状态锁已损坏");
            return;
        }
    };

    for (session_id, registration) in registrations {
        emit_oauth_error(&registration, &session_id, message);
    }
}

fn emit_oauth_error(registration: &OAuthCallbackRegistration, session_id: &str, message: &str) {
    let payload = OAuthCallbackErrorPayload {
        session_id: session_id.to_string(),
        message: message.to_string(),
    };
    if let Err(error) = registration.app.emit(
        &format!("{}-oauth-error", registration.event_prefix),
        &payload,
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
) -> bool {
    if let Ok(mut state) = server.state.lock()
        && state
            .callbacks
            .entries
            .get(&registration.callback_path)
            .is_some_and(|active| {
                active.phase == OAuthCallbackPhase::Processing
                    && Arc::ptr_eq(&active.registration, registration)
            })
    {
        state.callbacks.entries.remove(&registration.callback_path);
        return true;
    }

    false
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

    parse_callback_target(callback_port, path)
}

fn parse_callback_target(
    callback_port: u16,
    request_target: &str,
) -> Result<OAuthCallbackQuery, String> {
    let callback_url = format!("http://127.0.0.1:{callback_port}{request_target}");
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
            _ => {}
        }
    }

    Ok(query)
}
