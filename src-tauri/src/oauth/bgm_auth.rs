//! BGM OAuth 授权模块。
//!
//! 仅放需要 `BGM_APP_SECRET` 的流程：授权 URL、code 换 token、refresh。

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use sea_orm::{ActiveModelTrait, DatabaseConnection, Set};
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::database::repository::settings_repository::SettingsRepository;
use crate::entity::user::BgmAuth;
use crate::oauth::shared::{cancel_oauth_callback, generate_oauth_state, start_oauth_callback};

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

#[tauri::command]
pub async fn bgm_oauth_start_login(app: AppHandle) -> Result<String, String> {
    let state = generate_oauth_state()?;

    start_oauth_callback(
        app,
        "bgm",
        BGM_CALLBACK_PORT,
        BGM_CALLBACK_PATH,
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
pub async fn bgm_oauth_cancel_login() -> Result<(), String> {
    cancel_oauth_callback(BGM_CALLBACK_PORT, BGM_CALLBACK_PATH)
}

#[tauri::command]
pub async fn bgm_oauth_exchange_code(
    db: State<'_, DatabaseConnection>,
    code: String,
) -> Result<BgmAuth, String> {
    let app_secret = read_bgm_app_secret()?;

    let token_resp = request_token(&serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": BGM_APP_ID,
        "client_secret": app_secret,
        "code": code,
        "redirect_uri": BGM_REDIRECT_URI,
    }))
    .await?;

    let auth = BgmAuth {
        access_token: token_resp.access_token,
        refresh_token: token_resp.refresh_token,
        expires_at: Some(Utc::now().timestamp() + token_resp.expires_in),
        username: None,
        nickname: None,
    };

    store_bgm_auth(&db, &auth).await?;
    log::info!("BGM OAuth 授权信息已保存 expires_at={:?}", auth.expires_at);
    Ok(auth)
}

#[tauri::command]
pub async fn bgm_oauth_refresh_token(
    db: State<'_, DatabaseConnection>,
    refresh_token: String,
) -> Result<BgmAuth, String> {
    let app_secret = read_bgm_app_secret()?;

    let token_resp = request_token(&serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": BGM_APP_ID,
        "client_secret": app_secret,
        "refresh_token": refresh_token,
        "redirect_uri": BGM_REDIRECT_URI,
    }))
    .await?;

    let settings = SettingsRepository::get_all_settings(&db)
        .await
        .map_err(|e| format!("获取现有设置失败: {}", e))?;
    let existing = settings.bgm_auth.as_ref();

    let auth = BgmAuth {
        access_token: token_resp.access_token,
        refresh_token: token_resp
            .refresh_token
            .or_else(|| existing.and_then(|auth| auth.refresh_token.clone())),
        expires_at: Some(Utc::now().timestamp() + token_resp.expires_in),
        username: existing.and_then(|auth| auth.username.clone()),
        nickname: existing.and_then(|auth| auth.nickname.clone()),
    };

    store_bgm_auth(&db, &auth).await?;
    log::info!("BGM OAuth 授权信息已刷新 expires_at={:?}", auth.expires_at);
    Ok(auth)
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

    if let Ok(base_dir) = reina_path::get_base_data_dir() {
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

async fn store_bgm_auth(db: &DatabaseConnection, auth: &BgmAuth) -> Result<(), String> {
    let settings = SettingsRepository::get_all_settings(db)
        .await
        .map_err(|e| format!("获取用户记录失败: {}", e))?;

    let mut active: crate::entity::user::ActiveModel = settings.into();
    active.bgm_auth = Set(Some(auth.clone()));
    active
        .update(db)
        .await
        .map_err(|e| format!("保存 BGM 授权信息失败: {}", e))?;

    Ok(())
}
