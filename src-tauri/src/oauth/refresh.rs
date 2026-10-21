use sea_orm::DatabaseConnection;

use crate::{database::repository::settings_repository::SettingsRepository, entity::user};

/// Provider adapters describe their token protocol and typed credential fields.
/// This owner keeps the refresh attempt bound to the credential pair that began it.
pub(crate) trait ProviderRefresh {
    type Auth: Clone;
    type TokenResponse;
    type PreparedResponse;

    const PREPARE_BEFORE_PROFILE_RELOAD: bool = false;

    fn current_auth(settings: &user::Model) -> Option<Self::Auth>;
    fn matches_attempt(auth: &Self::Auth, expected_access_token: &str, refresh_token: &str)
    -> bool;
    async fn request_token(refresh_token: &str) -> Result<Self::TokenResponse, String>;
    fn prepare_response(response: Self::TokenResponse) -> Result<Self::PreparedResponse, String>;
    fn merge_response(response: Self::PreparedResponse, current_auth: Self::Auth) -> Self::Auth;
    async fn replace_if_current(
        db: &DatabaseConnection,
        expected_access_token: &str,
        refresh_token: &str,
        replacement: Self::Auth,
    ) -> Result<bool, String>;
    fn log_success(auth: &Self::Auth);
}

enum RefreshResponse<Token, Prepared> {
    Received(Token),
    Prepared(Prepared),
}

pub(crate) async fn refresh_provider_auth<P: ProviderRefresh>(
    db: &DatabaseConnection,
    refresh_token: String,
    expected_access_token: String,
) -> Result<Option<P::Auth>, String> {
    let initial_settings = SettingsRepository::get_all_settings(db)
        .await
        .map_err(|error| format!("获取现有设置失败: {error}"))?;
    let Some(initial_auth) = P::current_auth(&initial_settings) else {
        return Ok(None);
    };
    if !P::matches_attempt(&initial_auth, &expected_access_token, &refresh_token) {
        return Ok(None);
    }

    let response = P::request_token(&refresh_token).await?;
    let response = if P::PREPARE_BEFORE_PROFILE_RELOAD {
        RefreshResponse::Prepared(P::prepare_response(response)?)
    } else {
        RefreshResponse::Received(response)
    };

    // Refresh requests can outlive a user edit. Read the latest profile fields,
    // then let the conditional write be the final authority on token identity.
    let current_settings = SettingsRepository::get_all_settings(db)
        .await
        .map_err(|error| format!("获取现有设置失败: {error}"))?;
    let Some(current_auth) = P::current_auth(&current_settings) else {
        return Ok(None);
    };
    if !P::matches_attempt(&current_auth, &expected_access_token, &refresh_token) {
        return Ok(None);
    }

    let prepared = match response {
        RefreshResponse::Prepared(prepared) => prepared,
        RefreshResponse::Received(response) => P::prepare_response(response)?,
    };
    let replacement = P::merge_response(prepared, current_auth);
    if !P::replace_if_current(
        db,
        &expected_access_token,
        &refresh_token,
        replacement.clone(),
    )
    .await?
    {
        return Ok(None);
    }

    P::log_success(&replacement);
    Ok(Some(replacement))
}
