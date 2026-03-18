use oauth2::{
    basic::BasicClient,
    reqwest::async_http_client,
    AuthUrl,
    ClientId,
    ClientSecret,
    CsrfToken,
    PkceCodeChallenge,
    PkceCodeVerifier,
    RedirectUrl,
    RefreshToken,
    Scope,
    TokenResponse,
    TokenUrl,
};
use tiny_http::{Header, Response, Server};
use url::Url;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::StoredToken;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REDIRECT_PORT: u16 = 8765;

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn google_client() -> Result<BasicClient, String> {
    let client_id = std::env::var("GOOGLE_CLIENT_ID")
        .map_err(|_| "Missing GOOGLE_CLIENT_ID env var".to_string())?;

    let client_secret = std::env::var("GOOGLE_CLIENT_SECRET").ok();

    let auth_url = AuthUrl::new(AUTH_URL.to_string()).map_err(|e| e.to_string())?;
    let token_url = TokenUrl::new(TOKEN_URL.to_string()).map_err(|e| e.to_string())?;
    let redirect = RedirectUrl::new(format!("http://127.0.0.1:{}/callback", REDIRECT_PORT))
        .map_err(|e| e.to_string())?;

    Ok(BasicClient::new(
        ClientId::new(client_id),
        client_secret.map(ClientSecret::new),
        auth_url,
        Some(token_url),
    )
    .set_redirect_uri(redirect))
}

fn wait_for_auth_code(port: u16, expected_state: String) -> Result<String, String> {
    let server = Server::http(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    let request = server.recv().map_err(|e| e.to_string())?;

    let url = Url::parse(&format!("http://127.0.0.1:{}{}", port, request.url()))
        .map_err(|e| e.to_string())?;
    let query: HashMap<_, _> = url.query_pairs().into_owned().collect();

    let code = query
        .get("code")
        .cloned()
        .ok_or_else(|| "Authorization code missing in callback".to_string())?;

    let state = query
        .get("state")
        .cloned()
        .ok_or_else(|| "OAuth state missing in callback".to_string())?;

    if state != expected_state {
        let _ = request.respond(
            Response::from_string("State mismatch. You can close this window.")
                .with_status_code(400),
        );
        return Err("OAuth state mismatch".to_string());
    }
    let html = include_str!("../assets/oauth-success.html");
    let mut response = Response::from_string(html);
    if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]) {
        response = response.with_header(header);
    }
    let _ = request.respond(response);

    Ok(code)
}

pub async fn login_interactive() -> Result<StoredToken, String> {
    let client = google_client()?;
    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();

    let (auth_url, csrf_token) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new("https://mail.google.com/".to_string()))
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .set_pkce_challenge(pkce_challenge)
        .url();

    open::that(auth_url.as_str()).map_err(|e| e.to_string())?;

    let state = csrf_token.secret().to_string();
    let code = tokio::task::spawn_blocking(move || wait_for_auth_code(REDIRECT_PORT, state))
        .await
        .map_err(|e| e.to_string())??;

    let token_result = client
        .exchange_code(oauth2::AuthorizationCode::new(code))
        .set_pkce_verifier(PkceCodeVerifier::new(pkce_verifier.secret().to_string()))
        .request_async(async_http_client)
        .await
        .map_err(|e| e.to_string())?;

    let expires = token_result
        .expires_in()
        .map(|d| now_epoch() + d.as_secs() as i64);

    Ok(StoredToken {
        access_token: token_result.access_token().secret().to_string(),
        refresh_token: token_result
            .refresh_token()
            .map(|t| t.secret().to_string()),
        expires_at_epoch: expires,
    })
}

pub async fn refresh_access_token(refresh_token: &str) -> Result<StoredToken, String> {
    let client = google_client()?;
    let token_result = client
        .exchange_refresh_token(&RefreshToken::new(refresh_token.to_string()))
        .request_async(async_http_client)
        .await
        .map_err(|e| e.to_string())?;

    let expires = token_result
        .expires_in()
        .map(|d| now_epoch() + d.as_secs() as i64);

    Ok(StoredToken {
        access_token: token_result.access_token().secret().to_string(),
        refresh_token: token_result
            .refresh_token()
            .map(|t| t.secret().to_string())
            .or(Some(refresh_token.to_string())),
        expires_at_epoch: expires,
    })
}
