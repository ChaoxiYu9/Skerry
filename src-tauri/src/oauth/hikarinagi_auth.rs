//! Hikarinagi OIDC OAuth 授权模块。
//!
//! Hikarinagi 使用授权码 + PKCE；客户端不保存 client secret，refresh token 仅写入本地用户设置。

use std::time::Duration;

use chrono::Utc;
use sea_orm::DatabaseConnection;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::database::repository::settings_repository::SettingsRepository;
use crate::entity::user::HikarinagiAuth;
use crate::oauth::authorization_code::{
    OAuthTokenResponse, ProviderAuthorizationCode, exchange_authorization_code,
};
use crate::oauth::refresh::{ProviderRefresh, refresh_provider_auth};
use crate::oauth::shared::{
    calculate_oauth_expires_at, cancel_oauth_callback, generate_oauth_state, generate_pkce_pair,
    start_oauth_callback, validate_access_token,
};

const HIKARINAGI_CLIENT_ID: &str = "hkn_0YXH0QXtQHYqYRsT";
const HIKARINAGI_REDIRECT_URI: &str = "http://127.0.0.1:23380/callback/hikarinagi";
const HIKARINAGI_CALLBACK_PORT: u16 = 23380;
const HIKARINAGI_CALLBACK_PATH: &str = "/callback/hikarinagi";
const HIKARINAGI_CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const HIKARINAGI_AUTHORIZATION_ENDPOINT: &str = "https://id.hikarinagi.org/oidc/auth";
const HIKARINAGI_TOKEN_ENDPOINT: &str = "https://id.hikarinagi.org/oidc/token";
const HIKARINAGI_SCOPES: &str =
    "openid user:read catalog:read catalog:sync status:read status:write offline_access";

#[derive(Debug, Deserialize)]
struct HikarinagiTokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
}

impl OAuthTokenResponse for HikarinagiTokenResponse {
    fn access_token(&self) -> &str {
        &self.access_token
    }

    fn expires_in_seconds(&self) -> Option<i64> {
        Some(self.expires_in)
    }
}

struct HikarinagiAuthorizationCode;

impl ProviderAuthorizationCode for HikarinagiAuthorizationCode {
    type Auth = HikarinagiAuth;
    type TokenResponse = HikarinagiTokenResponse;
    type Profile = ();

    const PROVIDER_NAME: &'static str = "Hikarinagi";

    async fn request_token(
        code: &str,
        code_verifier: Option<&str>,
    ) -> Result<Self::TokenResponse, String> {
        let code_verifier =
            code_verifier.ok_or_else(|| "缺少 Hikarinagi PKCE verifier".to_string())?;
        request_token(&[
            ("grant_type", "authorization_code"),
            ("client_id", HIKARINAGI_CLIENT_ID),
            ("code", code.trim()),
            ("redirect_uri", HIKARINAGI_REDIRECT_URI),
            ("code_verifier", code_verifier.trim()),
        ])
        .await
    }

    async fn fetch_profile(_access_token: &str) -> Self::Profile {}

    fn build_auth(
        response: Self::TokenResponse,
        (): Self::Profile,
        expires_at: Option<i64>,
    ) -> Self::Auth {
        HikarinagiAuth {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_at,
            user_id: None,
            name: None,
        }
    }

    fn log_success(auth: &Self::Auth) {
        log::info!(
            "Hikarinagi OAuth 令牌已获取 expires_at={:?}",
            auth.expires_at
        );
    }
}

#[tauri::command]
pub async fn hikarinagi_oauth_start_login(
    app: AppHandle,
    session_id: String,
) -> Result<String, String> {
    let state = generate_oauth_state()?;
    let nonce = generate_oauth_state()?;
    let (code_verifier, code_challenge) = generate_pkce_pair()?;

    start_oauth_callback(
        app,
        "hikarinagi",
        HIKARINAGI_CALLBACK_PORT,
        HIKARINAGI_CALLBACK_PATH,
        session_id,
        HIKARINAGI_CALLBACK_TIMEOUT,
        state.clone(),
        Some(code_verifier),
    )?;

    let mut url = url::Url::parse(HIKARINAGI_AUTHORIZATION_ENDPOINT)
        .map_err(|error| format!("构造 Hikarinagi 授权地址失败: {error}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", HIKARINAGI_CLIENT_ID)
        .append_pair("redirect_uri", HIKARINAGI_REDIRECT_URI)
        .append_pair("scope", HIKARINAGI_SCOPES)
        .append_pair("prompt", "consent")
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256");

    Ok(url.to_string())
}

#[tauri::command]
pub async fn hikarinagi_oauth_exchange_code(
    code: String,
    code_verifier: String,
) -> Result<HikarinagiAuth, String> {
    exchange_authorization_code::<HikarinagiAuthorizationCode>(&code, Some(&code_verifier)).await
}

#[tauri::command]
pub async fn hikarinagi_oauth_cancel_login(session_id: String) -> Result<(), String> {
    cancel_oauth_callback(
        HIKARINAGI_CALLBACK_PORT,
        HIKARINAGI_CALLBACK_PATH,
        &session_id,
    )
}

#[tauri::command]
pub async fn hikarinagi_oauth_refresh_token(
    db: State<'_, DatabaseConnection>,
    refresh_token: String,
    expected_access_token: String,
) -> Result<Option<HikarinagiAuth>, String> {
    refresh_provider_auth::<HikarinagiRefresh>(&db, refresh_token, expected_access_token).await
}

struct HikarinagiRefresh;

impl ProviderRefresh for HikarinagiRefresh {
    type Auth = HikarinagiAuth;
    type TokenResponse = HikarinagiTokenResponse;
    type PreparedResponse = (String, Option<String>, i64);

    const PREPARE_BEFORE_PROFILE_RELOAD: bool = true;

    fn current_auth(settings: &crate::entity::user::Model) -> Option<Self::Auth> {
        settings.hikarinagi_auth.clone()
    }

    fn matches_attempt(
        auth: &Self::Auth,
        expected_access_token: &str,
        refresh_token: &str,
    ) -> bool {
        auth.access_token == expected_access_token
            && auth.refresh_token.as_deref() == Some(refresh_token.trim())
    }

    async fn request_token(refresh_token: &str) -> Result<Self::TokenResponse, String> {
        request_token(&[
            ("grant_type", "refresh_token"),
            ("client_id", HIKARINAGI_CLIENT_ID),
            ("refresh_token", refresh_token.trim()),
        ])
        .await
    }

    fn prepare_response(response: Self::TokenResponse) -> Result<Self::PreparedResponse, String> {
        validate_access_token("Hikarinagi", &response.access_token)?;
        let expires_at =
            calculate_oauth_expires_at("Hikarinagi", Utc::now().timestamp(), response.expires_in)?;
        Ok((response.access_token, response.refresh_token, expires_at))
    }

    fn merge_response(
        (access_token, refresh_token, expires_at): Self::PreparedResponse,
        current_auth: Self::Auth,
    ) -> Self::Auth {
        HikarinagiAuth {
            access_token,
            refresh_token: refresh_token.or(current_auth.refresh_token),
            expires_at: Some(expires_at),
            user_id: current_auth.user_id,
            name: current_auth.name,
        }
    }

    async fn replace_if_current(
        db: &DatabaseConnection,
        expected_access_token: &str,
        refresh_token: &str,
        replacement: Self::Auth,
    ) -> Result<bool, String> {
        SettingsRepository::replace_hikarinagi_auth_if_tokens_match(
            db,
            expected_access_token,
            refresh_token.trim(),
            Some(replacement),
        )
        .await
        .map_err(|error| format!("保存 Hikarinagi 授权信息失败: {error}"))
    }

    fn log_success(auth: &Self::Auth) {
        log::info!(
            "Hikarinagi OAuth 授权信息已刷新 expires_at={:?}",
            auth.expires_at
        );
    }
}

#[tauri::command]
pub async fn hikarinagi_oauth_clear_if_current(
    db: State<'_, DatabaseConnection>,
    access_token: String,
    refresh_token: Option<String>,
) -> Result<bool, String> {
    SettingsRepository::clear_hikarinagi_auth_if_tokens_match(
        &db,
        &access_token,
        refresh_token.as_deref(),
    )
    .await
    .map_err(|error| format!("清理 Hikarinagi 授权信息失败: {error}"))
}

async fn request_token(params: &[(&str, &str)]) -> Result<HikarinagiTokenResponse, String> {
    let response = crate::utils::http::get_client()
        .post(HIKARINAGI_TOKEN_ENDPOINT)
        .form(params)
        .send()
        .await
        .map_err(|error| format!("请求 Hikarinagi OAuth 接口失败: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 Hikarinagi OAuth 响应失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("Hikarinagi OAuth 请求失败 ({status}): {text}"));
    }

    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("解析 Hikarinagi OAuth 响应失败: {error} - {text}"))?;
    let token_value = value.get("data").cloned().unwrap_or(value);
    let token_response: HikarinagiTokenResponse = serde_json::from_value(token_value)
        .map_err(|error| format!("解析 Hikarinagi OAuth token 失败: {error} - {text}"))?;
    Ok(token_response)
}

#[cfg(test)]
mod refresh_contract_tests {
    use super::{HikarinagiRefresh, HikarinagiTokenResponse};
    use crate::{entity::user::HikarinagiAuth, oauth::refresh::ProviderRefresh};

    #[test]
    fn refresh_keeps_profile_and_existing_refresh_token_when_provider_omits_rotation() {
        let existing = HikarinagiAuth {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            expires_at: Some(100),
            user_id: Some(42),
            name: Some("user".into()),
        };

        let prepared = HikarinagiRefresh::prepare_response(HikarinagiTokenResponse {
            access_token: "new-access".into(),
            expires_in: 3600,
            refresh_token: None,
        })
        .unwrap();
        let refreshed = HikarinagiRefresh::merge_response(prepared, existing);

        assert_eq!(refreshed.access_token, "new-access");
        assert_eq!(refreshed.refresh_token.as_deref(), Some("old-refresh"));
        assert_eq!(refreshed.user_id, Some(42));
        assert_eq!(refreshed.name.as_deref(), Some("user"));
        assert!(refreshed.expires_at.is_some());
    }

    #[test]
    fn refresh_attempt_matches_hikarinagi_refresh_token_after_trimming() {
        let auth = HikarinagiAuth {
            access_token: "access".into(),
            refresh_token: Some("refresh".into()),
            ..HikarinagiAuth::default()
        };

        assert!(HikarinagiRefresh::matches_attempt(
            &auth,
            "access",
            " refresh "
        ));
    }
}
