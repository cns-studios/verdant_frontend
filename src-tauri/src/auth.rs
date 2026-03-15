use oauth2::{
    basic::BasicClient, AuthUrl, ClientId, CsrfToken, PkceCodeChallenge, RedirectUrl, Scope, TokenUrl, TokenResponse, reqwest::async_http_client
};
use tiny_http::{Response, Server, StatusCode};
use url::Url;
use std::collections::HashMap;

const CLIENT_ID: &str = "962153545199-31u8bepm21g2h2o1c2q2mdd4b2aee0ss.apps.googleusercontent.com";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

pub async fn run_auth_flow() -> Result<String, String> {
    let client_id = ClientId::new(CLIENT_ID.to_string());
    let auth_url = AuthUrl::new(AUTH_URL.to_string()).unwrap();
    let token_url = TokenUrl::new(TOKEN_URL.to_string()).unwrap();

    let client = BasicClient::new(client_id, None, auth_url, Some(token_url))
        .set_redirect_uri(RedirectUrl::new("http://localhost:8080".to_string()).unwrap());

    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();

    let (auth_url, _csrf_token) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new("https://mail.google.com/".to_string()))
        .set_pkce_challenge(pkce_challenge)
        .url();

    let _ = open::that(auth_url.to_string());

    let server = Server::http("127.0.0.1:8080").map_err(|e| e.to_string())?;
    
    for request in server.incoming_requests() {
        let url = Url::parse(&format!("http://localhost{}", request.url())).unwrap();
        let hash_query: HashMap<_, _> = url.query_pairs().into_owned().collect();

        if let Some(code) = hash_query.get("code") {
            let auth_code = oauth2::AuthorizationCode::new(code.to_string());
            
            let token_result = client
                .exchange_code(auth_code)
                .set_pkce_verifier(pkce_verifier)
                .request_async(async_http_client)
                .await
                .map_err(|e| e.to_string())?;

            let html = "<html><body><h1>Verification Successful!</h1><p>You can close this window now.</p></body></html>";
            let response = Response::from_string(html).with_status_code(200);
            let _ = request.respond(response);

            return Ok(token_result.access_token().secret().to_string());
        } else {
            let response = Response::from_string("Error: No code found").with_status_code(400);
            let _ = request.respond(response);
            return Err("Authorization failed".to_string());
        }
    }
    
    Err("Server shut down without authorization".to_string())
}
