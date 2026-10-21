//! BGM OAuth 授权模块。
//!
//! 仅放需要 `BGM_APP_SECRET` 的流程：授权 URL、code 换 token、refresh。

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use sea_orm::DatabaseConnection;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::database::repository::settings_repository::SettingsRepository;
use crate::entity::user::BgmAuth;
use crate::oauth::authorization_code::{
    OAuthTokenResponse, ProviderAuthorizationCode, exchange_authorization_code,
};
use crate::oauth::refresh::{ProviderRefresh, refresh_provider_auth};
use crate::oauth::shared::{
    calculate_oauth_expires_at, cancel_oauth_callback, generate_oauth_state, start_oauth_callback,
    validate_access_token,
};

const BGM_APP_ID: &str = "bgm70516a9a797a457b6";
const BGM_REDIRECT_URI: &str = "http://127.0.0.1:23380/callback";
const BGM_CALLBACK_PORT: u16 = 23380;
const BGM_CALLBACK_PATH: &str = "/callback";
const BGM_CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize)]
struct BgmTokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
}

impl OAuthTokenResponse for BgmTokenResponse {
    fn access_token(&self) -> &str {
        &self.access_token
    }

    fn expires_in_seconds(&self) -> Option<i64> {
        Some(self.expires_in)
    }
}

struct BgmAuthorizationCode;

impl ProviderAuthorizationCode for BgmAuthorizationCode {
    type Auth = BgmAuth;
    type TokenResponse = BgmTokenResponse;
    type Profile = ();

    const PROVIDER_NAME: &'static str = "BGM";

    async fn request_token(
        code: &str,
        _code_verifier: Option<&str>,
    ) -> Result<Self::TokenResponse, String> {
        let app_secret = read_bgm_app_secret()?;
        request_token(&serde_json::json!({
            "grant_type": "authorization_code",
            "client_id": BGM_APP_ID,
            "client_secret": app_secret,
            "code": code,
            "redirect_uri": BGM_REDIRECT_URI,
        }))
        .await
    }

    async fn fetch_profile(_access_token: &str) -> Self::Profile {}

    fn build_auth(
        response: Self::TokenResponse,
        (): Self::Profile,
        expires_at: Option<i64>,
    ) -> Self::Auth {
        BgmAuth {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_at,
            username: None,
            nickname: None,
        }
    }

    fn log_success(auth: &Self::Auth) {
        log::info!("BGM OAuth 令牌已获取 expires_at={:?}", auth.expires_at);
    }
}

#[tauri::command]
pub async fn bgm_oauth_start_login(app: AppHandle, session_id: String) -> Result<String, String> {
    let state = generate_oauth_state()?;

    start_oauth_callback(
        app,
        "bgm",
        BGM_CALLBACK_PORT,
        BGM_CALLBACK_PATH,
        session_id,
        BGM_CALLBACK_TIMEOUT,
        state.clone(),
        None,
    )?;

    let mut url = url::Url::parse("https://bgm.tv/oauth/authorize")
        .map_err(|e| format!("构造 BGM 授权地址失败: {}", e))?;
    url.query_pairs_mut()
        .append_pair("client_id", BGM_APP_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", BGM_REDIRECT_URI)
        .append_pair("state", &state);

    Ok(url.to_string())
}

#[tauri::command]
pub async fn bgm_oauth_cancel_login(session_id: String) -> Result<(), String> {
    cancel_oauth_callback(BGM_CALLBACK_PORT, BGM_CALLBACK_PATH, &session_id)
}

#[tauri::command]
pub async fn bgm_oauth_exchange_code(code: String) -> Result<BgmAuth, String> {
    exchange_authorization_code::<BgmAuthorizationCode>(&code, None).await
}

#[tauri::command]
pub async fn bgm_oauth_refresh_token(
    db: State<'_, DatabaseConnection>,
    refresh_token: String,
    expected_access_token: String,
) -> Result<Option<BgmAuth>, String> {
    refresh_provider_auth::<BgmRefresh>(&db, refresh_token, expected_access_token).await
}

struct BgmRefresh;

struct PreparedBgmRefresh {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
}

impl ProviderRefresh for BgmRefresh {
    type Auth = BgmAuth;
    type TokenResponse = BgmTokenResponse;
    type PreparedResponse = PreparedBgmRefresh;

    fn current_auth(settings: &crate::entity::user::Model) -> Option<Self::Auth> {
        settings.bgm_auth.clone()
    }

    fn matches_attempt(
        auth: &Self::Auth,
        expected_access_token: &str,
        refresh_token: &str,
    ) -> bool {
        auth.access_token == expected_access_token
            && auth.refresh_token.as_deref() == Some(refresh_token)
    }

    async fn request_token(refresh_token: &str) -> Result<Self::TokenResponse, String> {
        let app_secret = read_bgm_app_secret()?;
        request_token(&serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": BGM_APP_ID,
            "client_secret": app_secret,
            "refresh_token": refresh_token,
            "redirect_uri": BGM_REDIRECT_URI,
        }))
        .await
    }

    fn prepare_response(response: Self::TokenResponse) -> Result<Self::PreparedResponse, String> {
        validate_access_token("BGM", &response.access_token)?;
        let expires_at =
            calculate_oauth_expires_at("BGM", Utc::now().timestamp(), response.expires_in)?;
        Ok(PreparedBgmRefresh {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_at,
        })
    }

    fn merge_response(response: Self::PreparedResponse, current_auth: Self::Auth) -> Self::Auth {
        BgmAuth {
            access_token: response.access_token,
            refresh_token: response.refresh_token.or(current_auth.refresh_token),
            expires_at: Some(response.expires_at),
            username: current_auth.username,
            nickname: current_auth.nickname,
        }
    }

    async fn replace_if_current(
        db: &DatabaseConnection,
        expected_access_token: &str,
        refresh_token: &str,
        replacement: Self::Auth,
    ) -> Result<bool, String> {
        SettingsRepository::replace_bgm_auth_if_tokens_match(
            db,
            expected_access_token,
            refresh_token,
            Some(replacement),
        )
        .await
        .map_err(|error| format!("保存 BGM 授权信息失败: {error}"))
    }

    fn log_success(auth: &Self::Auth) {
        log::info!("BGM OAuth 授权信息已刷新 expires_at={:?}", auth.expires_at);
    }
}

#[tauri::command]
pub async fn bgm_oauth_clear_if_current(
    db: State<'_, DatabaseConnection>,
    access_token: String,
    refresh_token: Option<String>,
) -> Result<bool, String> {
    SettingsRepository::clear_bgm_auth_if_tokens_match(&db, &access_token, refresh_token.as_deref())
        .await
        .map_err(|error| format!("清理 BGM 授权信息失败: {error}"))
}

fn read_bgm_app_secret() -> Result<String, String> {
    if let Some(value) = option_env!("BGM_APP_SECRET") {
        if let Some(value) = normalize_bgm_app_secret(value) {
            return Ok(value);
        }
    }

    if let Ok(value) = std::env::var("BGM_APP_SECRET") {
        if let Some(value) = normalize_bgm_app_secret(&value) {
            return Ok(value);
        }
    }

    for path in bgm_app_secret_candidates() {
        if let Some(value) = read_bgm_app_secret_file(&path) {
            return Ok(value);
        }
    }

    Err(format!(
        "缺少 BGM_APP_SECRET。请设置环境变量，或把密钥写入 {} / {} / 程序同级 bgm_oauth_secret.txt",
        r"<Skerry 数据目录>\bgm_oauth_secret.txt", r"<Skerry 数据目录>\.env",
    ))
}

fn normalize_bgm_app_secret(value: &str) -> Option<String> {
    let value = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();
    if value.is_empty() { None } else { Some(value) }
}

fn read_bgm_app_secret_file(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    parse_bgm_app_secret_text(&text)
}

fn parse_bgm_app_secret_text(text: &str) -> Option<String> {
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.is_empty() {
        return None;
    }

    if let Some(value) = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("BGM_APP_SECRET")
                .or_else(|| value.get("bgm_app_secret"))
                .and_then(|value| value.as_str())
                .and_then(normalize_bgm_app_secret)
        })
    {
        return Some(value);
    }

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim() == "BGM_APP_SECRET" {
                return normalize_bgm_app_secret(value);
            }
        } else if let Some(value) = normalize_bgm_app_secret(line) {
            return Some(value);
        }
    }

    None
}

fn bgm_app_secret_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(base_dir) = skerry_path::get_base_data_dir() {
        candidates.push(base_dir.join("bgm_oauth_secret.txt"));
        candidates.push(base_dir.join("bgm_oauth_secret.json"));
        candidates.push(base_dir.join(".env"));
        candidates.push(base_dir.join("config").join("bgm_oauth_secret.txt"));
        candidates.push(base_dir.join("config").join(".env"));
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("bgm_oauth_secret.txt"));
            candidates.push(exe_dir.join("bgm_oauth_secret.json"));
            candidates.push(exe_dir.join(".env"));
            candidates.push(exe_dir.join("resources").join("bgm_oauth_secret.txt"));
            candidates.push(exe_dir.join("resources").join(".env"));
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("bgm_oauth_secret.txt"));
        candidates.push(current_dir.join(".env"));
    }

    candidates
}

async fn request_token(body: &serde_json::Value) -> Result<BgmTokenResponse, String> {
    let response = crate::utils::http::get_client()
        .post("https://bgm.tv/oauth/access_token")
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(body).map_err(|e| format!("序列化请求体失败: {}", e))?)
        .send()
        .await
        .map_err(|e| format!("请求 BGM OAuth 接口失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("BGM OAuth 请求失败 ({}): {}", status, body));
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("读取 BGM OAuth 响应失败: {}", e))?;

    serde_json::from_str(&text).map_err(|e| format!("解析 BGM OAuth 响应失败: {} - {}", e, text))
}

#[cfg(test)]
mod refresh_contract_tests {
    use super::{BgmRefresh, BgmTokenResponse};
    use crate::{entity::user::BgmAuth, oauth::refresh::ProviderRefresh};

    #[test]
    fn refresh_keeps_profile_and_existing_refresh_token_when_provider_omits_rotation() {
        let existing = BgmAuth {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            expires_at: Some(100),
            username: Some("user".into()),
            nickname: Some("nickname".into()),
        };

        let prepared = BgmRefresh::prepare_response(BgmTokenResponse {
            access_token: "new-access".into(),
            expires_in: 3600,
            refresh_token: None,
        })
        .unwrap();
        let refreshed = BgmRefresh::merge_response(prepared, existing);

        assert_eq!(refreshed.access_token, "new-access");
        assert_eq!(refreshed.refresh_token.as_deref(), Some("old-refresh"));
        assert_eq!(refreshed.username.as_deref(), Some("user"));
        assert_eq!(refreshed.nickname.as_deref(), Some("nickname"));
        assert!(refreshed.expires_at.is_some());
    }

    #[test]
    fn refresh_attempt_matches_bgm_tokens_without_trimming() {
        let auth = BgmAuth {
            access_token: "access".into(),
            refresh_token: Some("refresh".into()),
            ..BgmAuth::default()
        };

        assert!(BgmRefresh::matches_attempt(&auth, "access", "refresh"));
        assert!(!BgmRefresh::matches_attempt(&auth, "access", " refresh "));
    }
}
