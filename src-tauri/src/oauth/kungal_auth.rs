//! KunGal (NextMoe) OAuth 2.0 / OIDC 授权模块。
//!
//! 使用标准授权码 + PKCE 模式与 NextMoe 统一账号中心交互。

use std::time::Duration;

use chrono::Utc;
use sea_orm::DatabaseConnection;
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::database::repository::settings_repository::SettingsRepository;
use crate::entity::user::KungalAuth;
use crate::oauth::authorization_code::{
    OAuthTokenResponse, ProviderAuthorizationCode, exchange_authorization_code,
};
use crate::oauth::refresh::{ProviderRefresh, refresh_provider_auth};
use crate::oauth::shared::{
    calculate_oauth_expires_at, cancel_oauth_callback, generate_oauth_state, generate_pkce_pair,
    start_oauth_callback, validate_access_token,
};

const KUNGAL_CLIENT_ID: &str = "e8657225e5932ddaad8ce5bbcfe84751";
const KUNGAL_CLIENT_SECRET: &str = option_env!("KUNGAL_CLIENT_SECRET").unwrap_or("");
const KUNGAL_REDIRECT_URI: &str = "http://127.0.0.1:18533/oauth/callback";
const KUNGAL_CALLBACK_PORT: u16 = 18533;
const KUNGAL_CALLBACK_PATH: &str = "/oauth/callback";
const KUNGAL_CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const KUNGAL_AUTHORIZATION_ENDPOINT: &str = "https://account.nextmoe.com/api/v1/oauth/authorize";
const KUNGAL_TOKEN_ENDPOINT: &str = "https://account.nextmoe.com/api/v1/oauth/token";
const KUNGAL_USERINFO_ENDPOINT: &str = "https://account.nextmoe.com/api/v1/oauth/userinfo";
const KUNGAL_SCOPES: &str = "openid profile email preferences";

#[derive(Debug, Deserialize)]
struct KungalTokenResponse {
    access_token: String,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KungalUserInfoResponse {
    sub: Option<serde_json::Value>,
    name: Option<String>,
    nickname: Option<String>,
    picture: Option<String>,
    avatar: Option<String>,
}

impl OAuthTokenResponse for KungalTokenResponse {
    fn access_token(&self) -> &str {
        &self.access_token
    }

    fn expires_in_seconds(&self) -> Option<i64> {
        self.expires_in
    }
}

struct KungalAuthorizationCode;

impl ProviderAuthorizationCode for KungalAuthorizationCode {
    type Auth = KungalAuth;
    type TokenResponse = KungalTokenResponse;
    type Profile = Option<KungalUserInfoResponse>;

    const PROVIDER_NAME: &'static str = "KunGal";

    async fn request_token(
        code: &str,
        code_verifier: Option<&str>,
    ) -> Result<Self::TokenResponse, String> {
        let code_verifier = code_verifier.ok_or_else(|| "缺少 KunGal PKCE verifier".to_string())?;
        request_token(&[
            ("grant_type", "authorization_code"),
            ("client_id", KUNGAL_CLIENT_ID),
            ("client_secret", KUNGAL_CLIENT_SECRET),
            ("code", code.trim()),
            ("redirect_uri", KUNGAL_REDIRECT_URI),
            ("code_verifier", code_verifier.trim()),
        ])
        .await
    }

    async fn fetch_profile(access_token: &str) -> Self::Profile {
        fetch_user_info(access_token).await.ok()
    }

    fn build_auth(
        response: Self::TokenResponse,
        profile: Self::Profile,
        expires_at: Option<i64>,
    ) -> Self::Auth {
        let uid = profile.as_ref().and_then(|info| {
            info.sub.as_ref().and_then(|value| {
                if let Some(number) = value.as_i64() {
                    Some(number)
                } else if let Some(text) = value.as_str() {
                    text.parse::<i64>().ok()
                } else {
                    None
                }
            })
        });

        let nickname = profile
            .as_ref()
            .and_then(|info| info.nickname.clone().or_else(|| info.name.clone()));
        let username = profile.as_ref().and_then(|info| info.name.clone());
        let avatar = profile
            .as_ref()
            .and_then(|info| info.picture.clone().or_else(|| info.avatar.clone()));

        KungalAuth {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_at,
            uid,
            username,
            nickname,
            avatar,
        }
    }

    fn log_success(auth: &Self::Auth) {
        log::info!(
            "KunGal OAuth 令牌已获取 uid={:?} nickname={:?}",
            auth.uid,
            auth.nickname
        );
    }
}

#[tauri::command]
pub async fn kungal_oauth_start_login(
    app: AppHandle,
    session_id: String,
) -> Result<String, String> {
    let state = generate_oauth_state()?;
    let nonce = generate_oauth_state()?;
    let (code_verifier, code_challenge) = generate_pkce_pair()?;

    start_oauth_callback(
        app,
        "kungal",
        KUNGAL_CALLBACK_PORT,
        KUNGAL_CALLBACK_PATH,
        session_id,
        KUNGAL_CALLBACK_TIMEOUT,
        state.clone(),
        Some(code_verifier),
    )?;

    let mut url = url::Url::parse(KUNGAL_AUTHORIZATION_ENDPOINT)
        .map_err(|error| format!("构造 KunGal 授权地址失败: {error}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", KUNGAL_CLIENT_ID)
        .append_pair("redirect_uri", KUNGAL_REDIRECT_URI)
        .append_pair("scope", KUNGAL_SCOPES)
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256");

    Ok(url.to_string())
}

#[tauri::command]
pub async fn kungal_oauth_exchange_code(
    code: String,
    code_verifier: String,
) -> Result<KungalAuth, String> {
    exchange_authorization_code::<KungalAuthorizationCode>(&code, Some(&code_verifier)).await
}

#[tauri::command]
pub async fn kungal_oauth_cancel_login(session_id: String) -> Result<(), String> {
    cancel_oauth_callback(KUNGAL_CALLBACK_PORT, KUNGAL_CALLBACK_PATH, &session_id)
}

#[tauri::command]
pub async fn kungal_oauth_refresh_token(
    db: State<'_, DatabaseConnection>,
    refresh_token: String,
    expected_access_token: String,
) -> Result<Option<KungalAuth>, String> {
    refresh_provider_auth::<KungalRefresh>(&db, refresh_token, expected_access_token).await
}

struct KungalRefresh;

impl ProviderRefresh for KungalRefresh {
    type Auth = KungalAuth;
    type TokenResponse = KungalTokenResponse;
    type PreparedResponse = (String, Option<String>, Option<i64>);

    const PREPARE_BEFORE_PROFILE_RELOAD: bool = true;

    fn current_auth(settings: &crate::entity::user::Model) -> Option<Self::Auth> {
        settings.kungal_auth.clone()
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
            ("client_id", KUNGAL_CLIENT_ID),
            ("client_secret", KUNGAL_CLIENT_SECRET),
            ("refresh_token", refresh_token.trim()),
        ])
        .await
    }

    fn prepare_response(response: Self::TokenResponse) -> Result<Self::PreparedResponse, String> {
        validate_access_token("KunGal", &response.access_token)?;
        let expires_at = response
            .expires_in
            .map(|seconds| calculate_oauth_expires_at("KunGal", Utc::now().timestamp(), seconds))
            .transpose()?;
        Ok((response.access_token, response.refresh_token, expires_at))
    }

    fn merge_response(
        (access_token, refresh_token, expires_at): Self::PreparedResponse,
        current_auth: Self::Auth,
    ) -> Self::Auth {
        KungalAuth {
            access_token,
            refresh_token: refresh_token.or(current_auth.refresh_token),
            expires_at,
            uid: current_auth.uid,
            username: current_auth.username,
            nickname: current_auth.nickname,
            avatar: current_auth.avatar,
        }
    }

    async fn replace_if_current(
        db: &DatabaseConnection,
        expected_access_token: &str,
        refresh_token: &str,
        replacement: Self::Auth,
    ) -> Result<bool, String> {
        SettingsRepository::replace_kungal_auth_if_tokens_match(
            db,
            expected_access_token,
            refresh_token.trim(),
            Some(replacement),
        )
        .await
        .map_err(|error| format!("保存 KunGal 授权信息失败: {error}"))
    }

    fn log_success(auth: &Self::Auth) {
        log::info!("KunGal OAuth 授权信息已刷新 uid={:?}", auth.uid);
    }
}

#[tauri::command]
pub async fn kungal_oauth_clear_if_current(
    db: State<'_, DatabaseConnection>,
    access_token: String,
    refresh_token: Option<String>,
) -> Result<bool, String> {
    SettingsRepository::clear_kungal_auth_if_tokens_match(
        &db,
        &access_token,
        refresh_token.as_deref(),
    )
    .await
    .map_err(|error| format!("清理 KunGal 授权信息失败: {error}"))
}

async fn request_token(params: &[(&str, &str)]) -> Result<KungalTokenResponse, String> {
    let response = crate::utils::http::get_client()
        .post(KUNGAL_TOKEN_ENDPOINT)
        .form(params)
        .send()
        .await
        .map_err(|error| format!("请求 KunGal OAuth 接口失败: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 KunGal OAuth 响应失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("KunGal OAuth 请求失败 ({status}): {text}"));
    }

    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("解析 KunGal OAuth 响应失败: {error} - {text}"))?;
    let token_value = value.get("data").cloned().unwrap_or(value);
    let token_response: KungalTokenResponse = serde_json::from_value(token_value)
        .map_err(|error| format!("解析 KunGal OAuth token 失败: {error} - {text}"))?;
    Ok(token_response)
}

async fn fetch_user_info(access_token: &str) -> Result<KungalUserInfoResponse, String> {
    let response = crate::utils::http::get_client()
        .get(KUNGAL_USERINFO_ENDPOINT)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|error| format!("请求 NextMoe 用户信息失败: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 NextMoe 用户信息失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("NextMoe 用户信息请求失败 ({status}): {text}"));
    }

    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("解析 NextMoe 用户信息失败: {error} - {text}"))?;
    let user_value = value.get("data").cloned().unwrap_or(value);
    let user_info: KungalUserInfoResponse = serde_json::from_value(user_value)
        .map_err(|error| format!("反序列化 NextMoe 用户信息失败: {error} - {text}"))?;

    Ok(user_info)
}

#[cfg(test)]
mod refresh_contract_tests {
    use super::{KungalRefresh, KungalTokenResponse};
    use crate::{entity::user::KungalAuth, oauth::refresh::ProviderRefresh};

    #[test]
    fn refresh_preserves_optional_expiry_and_account_profile() {
        let existing = KungalAuth {
            access_token: "old-access".into(),
            refresh_token: Some("old-refresh".into()),
            expires_at: Some(100),
            uid: Some(42),
            username: Some("user".into()),
            nickname: Some("nickname".into()),
            avatar: Some("avatar".into()),
        };

        let prepared = KungalRefresh::prepare_response(KungalTokenResponse {
            access_token: "new-access".into(),
            expires_in: None,
            refresh_token: None,
        })
        .unwrap();
        let refreshed = KungalRefresh::merge_response(prepared, existing);

        assert_eq!(refreshed.access_token, "new-access");
        assert_eq!(refreshed.refresh_token.as_deref(), Some("old-refresh"));
        assert_eq!(refreshed.expires_at, None);
        assert_eq!(refreshed.uid, Some(42));
        assert_eq!(refreshed.username.as_deref(), Some("user"));
        assert_eq!(refreshed.nickname.as_deref(), Some("nickname"));
        assert_eq!(refreshed.avatar.as_deref(), Some("avatar"));
    }

    #[test]
    fn refresh_attempt_matches_kungal_refresh_token_after_trimming() {
        let auth = KungalAuth {
            access_token: "access".into(),
            refresh_token: Some("refresh".into()),
            ..KungalAuth::default()
        };

        assert!(KungalRefresh::matches_attempt(&auth, "access", " refresh "));
    }
}
