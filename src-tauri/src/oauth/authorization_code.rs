use chrono::Utc;

use crate::oauth::shared::{calculate_oauth_expires_at, validate_access_token};

pub(crate) trait OAuthTokenResponse {
    fn access_token(&self) -> &str;
    fn expires_in_seconds(&self) -> Option<i64>;
}

pub(crate) trait ProviderAuthorizationCode {
    type Auth;
    type TokenResponse: OAuthTokenResponse;
    type Profile;

    const PROVIDER_NAME: &'static str;

    async fn request_token(
        code: &str,
        code_verifier: Option<&str>,
    ) -> Result<Self::TokenResponse, String>;
    async fn fetch_profile(access_token: &str) -> Self::Profile;
    fn build_auth(
        response: Self::TokenResponse,
        profile: Self::Profile,
        expires_at: Option<i64>,
    ) -> Self::Auth;
    fn log_success(auth: &Self::Auth);
}

pub(crate) async fn exchange_authorization_code<P: ProviderAuthorizationCode>(
    code: &str,
    code_verifier: Option<&str>,
) -> Result<P::Auth, String> {
    let response = P::request_token(code, code_verifier).await?;
    validate_access_token(P::PROVIDER_NAME, response.access_token())?;

    // KunGal enriches the token with optional profile data before expiry is calculated.
    let profile = P::fetch_profile(response.access_token()).await;
    let expires_at = response
        .expires_in_seconds()
        .map(|seconds| {
            calculate_oauth_expires_at(P::PROVIDER_NAME, Utc::now().timestamp(), seconds)
        })
        .transpose()?;

    let auth = P::build_auth(response, profile, expires_at);
    P::log_success(&auth);
    Ok(auth)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    static PROFILE_FETCHED: AtomicBool = AtomicBool::new(false);

    struct TestTokenResponse {
        access_token: String,
        expires_in: Option<i64>,
    }

    impl OAuthTokenResponse for TestTokenResponse {
        fn access_token(&self) -> &str {
            &self.access_token
        }

        fn expires_in_seconds(&self) -> Option<i64> {
            self.expires_in
        }
    }

    struct TestProvider;

    impl ProviderAuthorizationCode for TestProvider {
        type Auth = (String, Option<i64>);
        type TokenResponse = TestTokenResponse;
        type Profile = ();

        const PROVIDER_NAME: &'static str = "OAuth test provider";

        async fn request_token(
            code: &str,
            _code_verifier: Option<&str>,
        ) -> Result<Self::TokenResponse, String> {
            Ok(TestTokenResponse {
                access_token: if code == "empty" {
                    String::new()
                } else {
                    "test-access-token".to_string()
                },
                expires_in: (code != "no-expiry").then_some(60),
            })
        }

        async fn fetch_profile(_access_token: &str) -> Self::Profile {
            PROFILE_FETCHED.store(true, Ordering::SeqCst);
        }

        fn build_auth(
            response: Self::TokenResponse,
            (): Self::Profile,
            expires_at: Option<i64>,
        ) -> Self::Auth {
            (response.access_token, expires_at)
        }

        fn log_success(_auth: &Self::Auth) {}
    }

    #[tokio::test]
    async fn shared_exchange_validates_before_profile_and_builds_expiry() {
        PROFILE_FETCHED.store(false, Ordering::SeqCst);
        let error = exchange_authorization_code::<TestProvider>("empty", None)
            .await
            .expect_err("empty access token must be rejected");
        assert!(error.contains("缺少 access_token"));
        assert!(!PROFILE_FETCHED.load(Ordering::SeqCst));

        let (access_token, expires_at) = exchange_authorization_code::<TestProvider>("valid", None)
            .await
            .expect("valid response should become credentials");
        assert_eq!(access_token, "test-access-token");
        assert!(expires_at.is_some());
        assert!(PROFILE_FETCHED.load(Ordering::SeqCst));

        let (_, expires_at) = exchange_authorization_code::<TestProvider>("no-expiry", None)
            .await
            .expect("token response without expiry remains valid");
        assert_eq!(expires_at, None);
    }
}
