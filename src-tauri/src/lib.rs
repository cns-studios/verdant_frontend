mod auth;
mod db;

use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use db::{clear_emails, clear_tokens, get_token, init_db, upsert_token, Email, StoredToken};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use semver::Version;
use std::env;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use tauri::{Manager, State};

struct DbState {
    conn: Mutex<Connection>,
    token: Mutex<Option<StoredToken>>,
}

#[derive(Serialize)]
struct AuthStatus {
    has_client_id: bool,
    connected: bool,
}

#[derive(Serialize)]
struct MailboxCounts {
    inbox_total: i64,
    inbox_unread: i64,
    starred_total: i64,
    sent_total: i64,
    drafts_total: i64,
    archive_total: i64,
}

#[derive(Serialize)]
struct UserProfile {
    name: String,
    email: String,
    initials: String,
}

#[derive(Serialize)]
struct DraftSaveResult {
    draft_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct AttachmentMeta {
    filename: String,
    mime_type: String,
    attachment_id: String,
    size: i64,
}

#[derive(Serialize)]
struct AttachmentDownload {
    filename: String,
    content_type: String,
    data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    release_name: String,
    published_at: String,
    notes: String,
    update_available: bool,
    download_asset_name: String,
    download_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadResult {
    file_path: String,
    file_name: String,
    version: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UpdateChannel {
    Stable,
    Nightly,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailAttachment {
    filename: String,
    #[serde(default)]
    content_type: String,
    data_base64: String,
}

fn updater_repo_owner() -> String {
    env::var("UPDATER_REPO_OWNER").unwrap_or_else(|_| "cns-studios".to_string())
}

fn updater_repo_name() -> String {
    env::var("UPDATER_REPO_NAME").unwrap_or_else(|_| "Verdant-Desktop".to_string())
}

fn parse_update_channel(raw: Option<String>) -> UpdateChannel {
    match raw
        .unwrap_or_else(|| "stable".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "nightly" | "beta" => UpdateChannel::Nightly,
        _ => UpdateChannel::Stable,
    }
}

fn normalize_version(raw: &str) -> String {
    raw.trim().trim_start_matches('v').to_string()
}

fn version_is_newer(current: &str, latest: &str) -> bool {
    match (Version::parse(current), Version::parse(latest)) {
        (Ok(c), Ok(l)) => l > c,
        _ => current != latest,
    }
}

fn preferred_asset_score(name: &str) -> i32 {
    let lower = name.to_ascii_lowercase();
    if cfg!(target_os = "windows") {
        if lower.ends_with(".msi") { return 100; }
        if lower.ends_with(".exe") { return 90; }
        if lower.contains("nsis") { return 80; }
    }

    if cfg!(target_os = "linux") {
        let has_pacman = std::process::Command::new("which")
            .arg("pacman")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let has_dpkg = std::process::Command::new("which")
            .arg("dpkg")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let has_rpm = std::process::Command::new("which")
            .arg("rpm")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if has_pacman && lower.ends_with(".pacman") { return 100; }
        if has_dpkg && lower.ends_with(".deb") { return 100; }
        if has_rpm && lower.ends_with(".rpm") { return 100; }
        if lower.ends_with(".appimage") { return 50; }
    }

    if cfg!(target_os = "macos") {
        if lower.ends_with(".dmg") { return 100; }
        if lower.ends_with(".app.tar.gz") { return 90; }
    }

    1
}

fn downloads_dir() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        if let Ok(base) = env::var("USERPROFILE") {
            return Ok(PathBuf::from(base).join("Downloads"));
        }
    } else if let Ok(base) = env::var("HOME") {
        return Ok(PathBuf::from(base).join("Downloads"));
    }

    env::current_dir()
        .map_err(|e| e.to_string())
        .map(|p| p.join("downloads"))
}

async fn fetch_latest_release() -> Result<Value, String> {
    let owner = updater_repo_owner();
    let repo = updater_repo_name();
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "verdant-desktop-updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub release lookup failed: {} {}", status, body));
    }

    response.json::<Value>().await.map_err(|e| e.to_string())
}

async fn fetch_latest_nightly_release() -> Result<Value, String> {
    let owner = updater_repo_owner();
    let repo = updater_repo_name();
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=30",
        owner, repo
    );

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "verdant-desktop-updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub nightly release lookup failed: {} {}",
            status, body
        ));
    }

    let releases = response.json::<Value>().await.map_err(|e| e.to_string())?;
    let Some(items) = releases.as_array() else {
        return Err("Unexpected nightly releases response".to_string());
    };

    for release in items {
        let is_prerelease = release
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_draft = release
            .get("draft")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let has_assets = release
            .get("assets")
            .and_then(Value::as_array)
            .map(|a| !a.is_empty())
            .unwrap_or(false);

        if is_prerelease && !is_draft && has_assets {
            return Ok(release.clone());
        }
    }

    Err("No nightly prerelease with assets found".to_string())
}

async fn fetch_release_for_channel(channel: UpdateChannel) -> Result<Value, String> {
    match channel {
        UpdateChannel::Stable => fetch_latest_release().await,
        UpdateChannel::Nightly => fetch_latest_nightly_release().await,
    }
}

fn select_best_asset(release: &Value) -> Result<(String, String), String> {
    let assets = release
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| "Release has no assets".to_string())?;

    let mut chosen_name = String::new();
    let mut chosen_url = String::new();
    let mut best_score = -1;

    for asset in assets {
        let Some(name) = asset.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(url) = asset
            .get("browser_download_url")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let score = preferred_asset_score(name);
        if score > best_score {
            best_score = score;
            chosen_name = name.to_string();
            chosen_url = url.to_string();
        }
    }

    if chosen_url.is_empty() {
        return Err("No downloadable release asset found".to_string());
    }

    Ok((chosen_name, chosen_url))
}

#[tauri::command]
async fn check_for_updates(channel: Option<String>) -> Result<UpdateInfo, String> {
    let channel = parse_update_channel(channel);
    let current_version = normalize_version(env!("CARGO_PKG_VERSION"));
    let release = fetch_release_for_channel(channel).await?;

    let latest_raw = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let latest_version = normalize_version(latest_raw);
    if latest_version.is_empty() {
        return Err("Latest release has no valid tag_name".to_string());
    }

    let update_available = if channel == UpdateChannel::Nightly {
        current_version != latest_version
    } else {
        version_is_newer(&current_version, &latest_version)
    };
    let release_name = release
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let published_at = release
        .get("published_at")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let notes = release
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let (download_asset_name, download_url) = select_best_asset(&release)?;

    Ok(UpdateInfo {
        current_version,
        latest_version,
        release_name,
        published_at,
        notes,
        update_available,
        download_asset_name,
        download_url,
    })
}

#[tauri::command]
async fn download_latest_update(channel: Option<String>) -> Result<UpdateDownloadResult, String> {
    let info = check_for_updates(channel).await?;
    if !info.update_available {
        return Err("No update available".to_string());
    }

    let client = reqwest::Client::new();
    let response = client
        .get(&info.download_url)
        .header(reqwest::header::USER_AGENT, "verdant-desktop-updater")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Update download failed: {} {}", status, body));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let folder = downloads_dir()?;
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file_path = folder.join(&info.download_asset_name);
    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;

    let path_str = file_path.to_string_lossy().to_string();
    let lower = info.download_asset_name.to_ascii_lowercase();

    install_update(&path_str, &lower)?;

    Ok(UpdateDownloadResult {
        file_path: path_str,
        file_name: info.download_asset_name,
        version: info.latest_version,
    })
}

fn install_update(path: &str, name: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if name.ends_with(".pacman") || name.ends_with(".pkg.tar.zst") {
            std::process::Command::new("pkexec")
                .args(["pacman", "-U", "--noconfirm", path])
                .status()
                .map_err(|e| format!("Failed to launch pacman: {}", e))?;
        } else if name.ends_with(".deb") {
            let apt = std::process::Command::new("pkexec")
                .args(["apt-get", "install", "-y", path])
                .status();
            if apt.is_err() {
                std::process::Command::new("pkexec")
                    .args(["dpkg", "-i", path])
                    .status()
                    .map_err(|e| format!("Failed to launch dpkg: {}", e))?;
            }
        } else if name.ends_with(".rpm") {
            let dnf = std::process::Command::new("pkexec")
                .args(["dnf", "install", "-y", path])
                .status();
            if dnf.is_err() {
                std::process::Command::new("pkexec")
                    .args(["rpm", "-U", path])
                    .status()
                    .map_err(|e| format!("Failed to launch rpm: {}", e))?;
            }
        } else if name.ends_with(".appimage") {
            std::fs::set_permissions(
                path,
                std::os::unix::fs::PermissionsExt::from_mode(0o755),
            )
            .map_err(|e| e.to_string())?;
            std::process::Command::new(path)
                .spawn()
                .map_err(|e| format!("Failed to launch AppImage: {}", e))?;
            std::process::exit(0);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if name.ends_with(".exe") || name.ends_with(".msi") {
            std::process::Command::new("powershell")
                .args([
                    "-Command",
                    &format!(
                        "Start-Process -FilePath '{}' -Verb RunAs",
                        path
                    ),
                ])
                .spawn()
                .map_err(|e| format!("Failed to launch installer: {}", e))?;
            std::process::exit(0);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if name.ends_with(".dmg") {
            open::that(path).map_err(|e| e.to_string())?;
            std::process::exit(0);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        std::process::Command::new(current_exe)
            .spawn()
            .map_err(|e| e.to_string())?;
        std::process::exit(0);
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    open::that(path).map_err(|e| e.to_string())?;

    Ok(())
}

fn sanitize_header_value(input: &str) -> String {
    input.replace(['\r', '\n'], " ").trim().to_string()
}

fn fold_base64_for_mime(encoded: &str) -> String {
    let mut out = String::with_capacity(encoded.len() + (encoded.len() / 76) + 8);
    for chunk in encoded.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push_str("\r\n");
    }
    out
}

fn markdown_to_html(markdown: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};

    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(markdown, options);
    let mut html_out = String::new();
    html::push_html(&mut html_out, parser);
    html_out
}

fn build_raw_mime_message(
    to: String,
    cc: String,
    subject: String,
    body: String,
    mode: String,
    body_html: Option<String>,
    attachments: Vec<EmailAttachment>,
) -> Result<String, String> {
    let to = sanitize_header_value(&to);
    let cc = sanitize_header_value(&cc);
    let subject = sanitize_header_value(&subject);
    let is_markdown = mode.eq_ignore_ascii_case("markdown");
    let is_html = mode.eq_ignore_ascii_case("html");
    let html_body = if is_html {
        let provided = body_html.unwrap_or_default();
        if provided.trim().is_empty() {
            markdown_to_html(&body)
        } else {
            provided
        }
    } else {
        markdown_to_html(&body)
    };

    let mut raw_message = String::new();
    if !to.is_empty() {
        raw_message.push_str(&format!("To: {}\r\n", to));
    }
    if !cc.is_empty() {
        raw_message.push_str(&format!("Cc: {}\r\n", cc));
    }
    raw_message.push_str(&format!("Subject: {}\r\n", subject));
    raw_message.push_str("MIME-Version: 1.0\r\n");

    if attachments.is_empty() && !is_markdown && !is_html {
        raw_message.push_str("Content-Type: text/plain; charset=UTF-8\r\n\r\n");
        raw_message.push_str(&body);
    } else {
        let mixed_boundary = "verdant-mixed-001";
        let alt_boundary = "verdant-alt-001";

        if attachments.is_empty() {
            raw_message.push_str(&format!(
                "Content-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n",
                alt_boundary
            ));
            raw_message.push_str(&format!("--{}\r\n", alt_boundary));
            raw_message.push_str("Content-Type: text/plain; charset=UTF-8\r\n\r\n");
            raw_message.push_str(&body);
            raw_message.push_str("\r\n");
            raw_message.push_str(&format!("--{}\r\n", alt_boundary));
            raw_message.push_str("Content-Type: text/html; charset=UTF-8\r\n\r\n");
            raw_message.push_str(&html_body);
            raw_message.push_str("\r\n");
            raw_message.push_str(&format!("--{}--\r\n", alt_boundary));
        } else {
            raw_message.push_str(&format!(
                "Content-Type: multipart/mixed; boundary=\"{}\"\r\n\r\n",
                mixed_boundary
            ));

            raw_message.push_str(&format!("--{}\r\n", mixed_boundary));
            if is_markdown || is_html {
                raw_message.push_str(&format!(
                    "Content-Type: multipart/alternative; boundary=\"{}\"\r\n\r\n",
                    alt_boundary
                ));
                raw_message.push_str(&format!("--{}\r\n", alt_boundary));
                raw_message.push_str("Content-Type: text/plain; charset=UTF-8\r\n\r\n");
                raw_message.push_str(&body);
                raw_message.push_str("\r\n");
                raw_message.push_str(&format!("--{}\r\n", alt_boundary));
                raw_message.push_str("Content-Type: text/html; charset=UTF-8\r\n\r\n");
                raw_message.push_str(&html_body);
                raw_message.push_str("\r\n");
                raw_message.push_str(&format!("--{}--\r\n", alt_boundary));
            } else {
                raw_message.push_str("Content-Type: text/plain; charset=UTF-8\r\n\r\n");
                raw_message.push_str(&body);
                raw_message.push_str("\r\n");
            }

            for attachment in attachments {
                let raw_bytes = STANDARD
                    .decode(attachment.data_base64.as_bytes())
                    .map_err(|_| format!("Invalid attachment encoding for {}", attachment.filename))?;
                let attachment_encoded = STANDARD.encode(raw_bytes);
                let content_type = if attachment.content_type.trim().is_empty() {
                    "application/octet-stream".to_string()
                } else {
                    attachment.content_type
                };
                let safe_filename = sanitize_header_value(&attachment.filename);

                raw_message.push_str(&format!("--{}\r\n", mixed_boundary));
                raw_message.push_str(&format!(
                    "Content-Type: {}; name=\"{}\"\r\n",
                    content_type, safe_filename
                ));
                raw_message.push_str("Content-Transfer-Encoding: base64\r\n");
                raw_message.push_str(&format!(
                    "Content-Disposition: attachment; filename=\"{}\"\r\n\r\n",
                    safe_filename
                ));
                raw_message.push_str(&fold_base64_for_mime(&attachment_encoded));
            }

            raw_message.push_str(&format!("--{}--\r\n", mixed_boundary));
        }
    }

    Ok(URL_SAFE_NO_PAD.encode(raw_message.as_bytes()))
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn decode_gmail_base64(data: &str) -> Option<String> {
    URL_SAFE_NO_PAD
        .decode(data.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

fn header_value(headers: &[Value], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|h| {
            h.get("name")
                .and_then(Value::as_str)
                .map(|n| n.eq_ignore_ascii_case(name))
                .unwrap_or(false)
        })
        .and_then(|h| h.get("value").and_then(Value::as_str).map(str::to_string))
}

fn strip_confusable_chars(input: &str) -> String {
    input
        .chars()
        .filter(|c| {
            !matches!(
                *c,
                '\u{00AD}'
                    | '\u{034F}'
                    | '\u{061C}'
                    | '\u{180E}'
                    | '\u{200B}'
                    | '\u{200C}'
                    | '\u{200D}'
                    | '\u{200E}'
                    | '\u{200F}'
                    | '\u{202A}'
                    | '\u{202B}'
                    | '\u{202C}'
                    | '\u{202D}'
                    | '\u{202E}'
                    | '\u{2060}'
                    | '\u{2061}'
                    | '\u{2062}'
                    | '\u{2063}'
                    | '\u{2064}'
                    | '\u{2066}'
                    | '\u{2067}'
                    | '\u{2068}'
                    | '\u{2069}'
                    | '\u{FEFF}'
            )
        })
        .collect()
}

fn extract_body(payload: &Value) -> Option<String> {
    let mime = payload
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let body_data = payload
        .get("body")
        .and_then(|b| b.get("data"))
        .and_then(Value::as_str);

    if let Some(data) = body_data {
        let decoded = decode_gmail_base64(data)?;
        let cleaned = strip_confusable_chars(&decoded);
        if mime.eq_ignore_ascii_case("text/html") {
            return Some(cleaned);
        }
        if mime.eq_ignore_ascii_case("text/plain") {
            return Some(format!("<pre>{}</pre>", cleaned));
        }
    }

    if let Some(parts) = payload.get("parts").and_then(Value::as_array) {
        for part in parts {
            if let Some(found) = extract_body(part) {
                return Some(found);
            }
        }
    }

    None
}

fn collect_attachments(payload: &Value, out: &mut Vec<AttachmentMeta>) {
    let filename = payload
        .get("filename")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let attachment_id = payload
        .get("body")
        .and_then(|b| b.get("attachmentId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    if !filename.is_empty() && !attachment_id.is_empty() {
        let mime_type = payload
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_string();
        let size = payload
            .get("body")
            .and_then(|b| b.get("size"))
            .and_then(Value::as_i64)
            .unwrap_or(0);

        out.push(AttachmentMeta {
            filename,
            mime_type,
            attachment_id,
            size,
        });
    }

    if let Some(parts) = payload.get("parts").and_then(Value::as_array) {
        for part in parts {
            collect_attachments(part, out);
        }
    }
}

async fn persist_token(state: &DbState, token: StoredToken) -> Result<StoredToken, String> {
    {
        let conn = state.conn.lock().await;
        upsert_token(&conn, &token).map_err(|e| e.to_string())?;
    }
    {
        let mut cache = state.token.lock().await;
        *cache = Some(token.clone());
    }
    Ok(token)
}

async fn ensure_token(state: &DbState) -> Result<StoredToken, String> {
    if let Some(cached) = state.token.lock().await.clone() {
        let valid = cached
            .expires_at_epoch
            .map(|exp| exp > now_epoch() + 60)
            .unwrap_or(true);
        if valid {
            return Ok(cached);
        }
    }

    let from_db = {
        let conn = state.conn.lock().await;
        get_token(&conn).map_err(|e| e.to_string())?
    };

    if let Some(db_token) = from_db {
        let valid = db_token
            .expires_at_epoch
            .map(|exp| exp > now_epoch() + 60)
            .unwrap_or(true);
        if valid {
            let mut cache = state.token.lock().await;
            *cache = Some(db_token.clone());
            return Ok(db_token);
        }

        if let Some(refresh) = db_token.refresh_token.clone() {
            let refreshed = auth::refresh_access_token(&refresh).await?;
            return persist_token(state, refreshed).await;
        }
    }

    let fresh = auth::login_interactive().await?;
    persist_token(state, fresh).await
}

fn mailbox_label(mailbox: &str) -> Option<&'static str> {
    match mailbox {
        "INBOX" => Some("INBOX"),
        "SENT" => Some("SENT"),
        "DRAFT" => Some("DRAFT"),
        _ => None,
    }
}

fn mailbox_from_labels(labels: &str) -> String {
    let parts: Vec<&str> = labels.split(',').collect();
    if parts.contains(&"SENT") {
        "SENT".to_string()
    } else if parts.contains(&"DRAFT") {
        "DRAFT".to_string()
    } else if parts.contains(&"INBOX") {
        "INBOX".to_string()
    } else {
        "ARCHIVE".to_string()
    }
}

async fn sync_mailbox_page_internal(
    state: &DbState,
    mailbox: &str,
    page_token: Option<String>,
) -> Result<Option<String>, String> {
    let Some(label) = mailbox_label(mailbox) else {
        return Ok(None);
    };

    let client = reqwest::Client::new();
    let token = ensure_token(state).await?.access_token;

    let mut list_url = if mailbox == "DRAFT" {
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=50".to_string()
    } else {
        format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds={}&maxResults=50",
            label
        )
    };
    if let Some(token) = page_token {
        if !token.trim().is_empty() {
            list_url.push_str("&pageToken=");
            list_url.push_str(token.trim());
        }
    }
    let res = client
        .get(list_url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Gmail list API failed: {} {}", status, body));
    }

    let json = res.json::<Value>().await.map_err(|e| e.to_string())?;
    let next_page_token = json
        .get("nextPageToken")
        .and_then(Value::as_str)
        .map(str::to_string);

    let message_refs: Vec<(String, Option<String>)> = if mailbox == "DRAFT" {
        json.get("drafts")
            .and_then(Value::as_array)
            .map(|drafts| {
                drafts
                    .iter()
                    .filter_map(|draft| {
                        let draft_id = draft.get("id").and_then(Value::as_str)?.to_string();
                        let message_id = draft
                            .get("message")
                            .and_then(|m| m.get("id"))
                            .and_then(Value::as_str)?
                            .to_string();
                        Some((message_id, Some(draft_id)))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        json.get("messages")
            .and_then(Value::as_array)
            .map(|messages| {
                messages
                    .iter()
                    .filter_map(|msg| {
                        msg.get("id")
                            .and_then(Value::as_str)
                            .map(|id| (id.to_string(), None))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };

    for (id, draft_id) in message_refs {
        if id.is_empty() {
            continue;
        }

        // Fast path for existing emails: keep metadata fresh but skip full-body fetch.
        let exists = {
            let conn = state.conn.lock().await;
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM emails WHERE id = ?1", [id.as_str()], |r| r.get(0))
                .unwrap_or(0);
            count > 0
        };

        let detail_url = if mailbox == "DRAFT" {
            format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/drafts/{}?format=full",
                draft_id.clone().unwrap_or_default()
            )
        } else {
            format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=full",
                id
            )
        };
        let detail = client
            .get(detail_url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !detail.status().is_success() {
            continue;
        }

        let raw_detail = detail.json::<Value>().await.map_err(|e| e.to_string())?;
        let detail_json = if mailbox == "DRAFT" {
            raw_detail
                .get("message")
                .cloned()
                .unwrap_or_else(|| json!({}))
        } else {
            raw_detail.clone()
        };

        let resolved_draft_id = if mailbox == "DRAFT" {
            draft_id.clone().or_else(|| {
                raw_detail
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        } else {
            None
        };

        let thread_id = detail_json
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let snippet = strip_confusable_chars(
            detail_json
                .get("snippet")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );

        let headers = detail_json
            .get("payload")
            .and_then(|p| p.get("headers"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let subject = strip_confusable_chars(
            &header_value(&headers, "Subject").unwrap_or_else(|| "(No Subject)".to_string()),
        );
        let sender = strip_confusable_chars(
            &header_value(&headers, "From").unwrap_or_else(|| "Unknown Sender".to_string()),
        );
        let to_recipients = strip_confusable_chars(&header_value(&headers, "To").unwrap_or_default());
        let cc_recipients = strip_confusable_chars(&header_value(&headers, "Cc").unwrap_or_default());
        let date = header_value(&headers, "Date").unwrap_or_else(|| "Unknown Date".to_string());
        let internal_ts = detail_json
            .get("internalDate")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);

        let (existing_body, existing_attachments) = if exists {
            let conn = state.conn.lock().await;
            let body = conn
                .query_row("SELECT body_html FROM emails WHERE id = ?1", [id.as_str()], |r| r.get::<_, String>(0))
                .ok();
            let attachments = conn
                .query_row(
                    "SELECT attachments_json FROM emails WHERE id = ?1",
                    [id.as_str()],
                    |r| r.get::<_, String>(0),
                )
                .ok();
            (body, attachments)
        } else {
            (None, None)
        };

        let body_html = detail_json
            .get("payload")
            .and_then(extract_body)
            .or(existing_body)
            .unwrap_or_else(|| format!("<pre>{}</pre>", snippet));

        let mut attachments = Vec::new();
        if let Some(payload) = detail_json.get("payload") {
            collect_attachments(payload, &mut attachments);
        }

        let attachments_json = if attachments.is_empty() {
            existing_attachments.unwrap_or_else(|| "[]".to_string())
        } else {
            serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".to_string())
        };
        let has_attachments = !attachments_json.trim().is_empty() && attachments_json.trim() != "[]";

        let labels = detail_json
            .get("labelIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();

        let is_read = !labels.split(',').any(|l| l == "UNREAD");

        let conn = state.conn.lock().await;
        conn.execute(
                "INSERT INTO emails (id, draft_id, thread_id, subject, sender, to_recipients, cc_recipients, snippet, body_html, attachments_json, has_attachments, date, is_read, mailbox, labels, internal_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id)
             DO UPDATE SET
                     draft_id = excluded.draft_id,
                thread_id = excluded.thread_id,
                subject = excluded.subject,
                sender = excluded.sender,
                to_recipients = excluded.to_recipients,
                cc_recipients = excluded.cc_recipients,
                snippet = excluded.snippet,
                body_html = excluded.body_html,
                attachments_json = excluded.attachments_json,
                has_attachments = excluded.has_attachments,
                date = excluded.date,
                mailbox = excluded.mailbox,
                labels = excluded.labels,
                internal_ts = excluded.internal_ts",
            (
                id,
                resolved_draft_id,
                &thread_id,
                &subject,
                &sender,
                &to_recipients,
                &cc_recipients,
                &snippet,
                &body_html,
                &attachments_json,
                has_attachments as i32,
                &date,
                is_read as i32,
                mailbox,
                &labels,
                internal_ts,
            ),
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(next_page_token)
}

async fn sync_mailbox_internal(state: &DbState, mailbox: &str) -> Result<(), String> {
    let _ = sync_mailbox_page_internal(state, mailbox, None).await?;
    Ok(())
}

#[tauri::command]
async fn connect_gmail(state: State<'_, DbState>) -> Result<(), String> {
    let fresh = auth::login_interactive().await?;
    let _ = persist_token(&state, fresh).await?;
    Ok(())
}

#[tauri::command]
async fn sync_emails(state: State<'_, DbState>) -> Result<(), String> {
    sync_mailbox_internal(&state, "INBOX").await
}

#[tauri::command]
async fn sync_mailbox(state: State<'_, DbState>, mailbox: String) -> Result<(), String> {
    sync_mailbox_internal(&state, mailbox.as_str()).await
}

#[tauri::command]
async fn sync_mailbox_page(
    state: State<'_, DbState>,
    mailbox: String,
    page_token: Option<String>,
) -> Result<Option<String>, String> {
    sync_mailbox_page_internal(&state, mailbox.as_str(), page_token).await
}

#[tauri::command]
async fn get_emails(
    state: State<'_, DbState>,
    mailbox: Option<String>,
) -> Result<Vec<Email>, String> {
    let box_name = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let conn = state.conn.lock().await;

    let sql = if box_name == "STARRED" {
        "SELECT id, draft_id, thread_id, subject, sender, to_recipients, cc_recipients, snippet, body_html, attachments_json, has_attachments, date, is_read, starred, mailbox, labels, internal_ts
         FROM emails WHERE starred = 1 ORDER BY internal_ts DESC, rowid DESC LIMIT 500"
    } else {
        "SELECT id, draft_id, thread_id, subject, sender, to_recipients, cc_recipients, snippet, body_html, attachments_json, has_attachments, date, is_read, starred, mailbox, labels, internal_ts
         FROM emails WHERE mailbox = ?1 ORDER BY internal_ts DESC, rowid DESC LIMIT 500"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(Email {
            id: row.get(0)?,
            draft_id: row.get(1)?,
            thread_id: row.get(2)?,
            subject: row.get(3)?,
            sender: row.get(4)?,
            to_recipients: row.get(5)?,
            cc_recipients: row.get(6)?,
            snippet: row.get(7)?,
            body_html: row.get(8)?,
            attachments_json: row.get(9)?,
            has_attachments: row.get::<_, i32>(10)? != 0,
            date: row.get(11)?,
            is_read: row.get::<_, i32>(12)? != 0,
            starred: row.get::<_, i32>(13)? != 0,
            mailbox: row.get(14)?,
            labels: row.get(15)?,
            internal_ts: row.get(16)?,
        })
    };

    let emails = if box_name == "STARRED" {
        stmt.query_map([], mapper)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect()
    } else {
        stmt.query_map([box_name.as_str()], mapper)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect()
    };

    Ok(emails)
}

#[tauri::command]
async fn deep_search_emails(
    state: State<'_, DbState>,
    query: String,
) -> Result<Vec<Email>, String> {
    let token = ensure_token(&state).await?.access_token;
    let client = reqwest::Client::new();
    let q = format!("in:anywhere {}", query.trim());

    let list = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .query(&[("maxResults", "100"), ("q", q.as_str())])
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !list.status().is_success() {
        let status = list.status();
        let body = list.text().await.unwrap_or_default();
        return Err(format!("Deep search failed: {} {}", status, body));
    }

    let json = list.json::<Value>().await.map_err(|e| e.to_string())?;
    let refs = json
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut results = Vec::new();
    for msg in refs {
        let Some(id) = msg.get("id").and_then(Value::as_str) else {
            continue;
        };

        let detail = client
            .get(format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=full",
                id
            ))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !detail.status().is_success() {
            continue;
        }

        let detail_json = detail.json::<Value>().await.map_err(|e| e.to_string())?;
        let headers = detail_json
            .get("payload")
            .and_then(|p| p.get("headers"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let snippet = strip_confusable_chars(
            detail_json
                .get("snippet")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        let subject = strip_confusable_chars(
            &header_value(&headers, "Subject").unwrap_or_else(|| "(No Subject)".to_string()),
        );
        let sender = strip_confusable_chars(
            &header_value(&headers, "From").unwrap_or_else(|| "Unknown Sender".to_string()),
        );
        let to_recipients = strip_confusable_chars(&header_value(&headers, "To").unwrap_or_default());
        let cc_recipients = strip_confusable_chars(&header_value(&headers, "Cc").unwrap_or_default());
        let date = header_value(&headers, "Date").unwrap_or_else(|| "Unknown Date".to_string());
        let labels = detail_json
            .get("labelIds")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let internal_ts = detail_json
            .get("internalDate")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let body_html = detail_json
            .get("payload")
            .and_then(extract_body)
            .unwrap_or_else(|| format!("<pre>{}</pre>", snippet));
        let mut attachments = Vec::new();
        if let Some(payload) = detail_json.get("payload") {
            collect_attachments(payload, &mut attachments);
        }
        let attachments_json = serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".to_string());

        results.push(Email {
            id: id.to_string(),
            draft_id: None,
            thread_id: detail_json
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            subject,
            sender,
            to_recipients,
            cc_recipients,
            snippet,
            body_html,
            attachments_json,
            has_attachments: !attachments.is_empty(),
            date,
            is_read: !labels.split(',').any(|l| l == "UNREAD"),
            starred: labels.split(',').any(|l| l == "STARRED"),
            mailbox: mailbox_from_labels(&labels),
            labels,
            internal_ts,
        });
    }

    Ok(results)
}

#[tauri::command]
async fn set_email_read_status(state: State<'_, DbState>, email_id: String, is_read: bool) -> Result<(), String> {
    let conn = state.conn.lock().await;
    conn.execute(
        "UPDATE emails SET is_read = ?1 WHERE id = ?2",
        (is_read as i32, email_id),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn toggle_starred(state: State<'_, DbState>, email_id: String) -> Result<(), String> {
    let conn = state.conn.lock().await;
    conn.execute(
        "UPDATE emails SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END WHERE id = ?1",
        [email_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn archive_email(state: State<'_, DbState>, email_id: String) -> Result<(), String> {
    let token = ensure_token(&state).await?.access_token;
    let client = reqwest::Client::new();
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify", email_id);

    let res = client
        .post(url)
        .bearer_auth(&token)
        .json(&json!({"removeLabelIds": ["INBOX"]}))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Archive failed: {}", res.status()));
    }

    let conn = state.conn.lock().await;
    conn.execute("UPDATE emails SET mailbox = 'ARCHIVE' WHERE id = ?1", [email_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn trash_email(state: State<'_, DbState>, email_id: String) -> Result<(), String> {
    let token = ensure_token(&state).await?.access_token;
    let client = reqwest::Client::new();
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/trash", email_id);

    let res = client
        .post(url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Trash failed: {}", res.status()));
    }

    let conn = state.conn.lock().await;
    conn.execute("DELETE FROM emails WHERE id = ?1", [email_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_mailbox_counts(state: State<'_, DbState>) -> Result<MailboxCounts, String> {
    let conn = state.conn.lock().await;

    let inbox_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM emails WHERE mailbox = 'INBOX'", [], |r| r.get(0))
        .unwrap_or(0);
    let inbox_unread: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM emails WHERE mailbox = 'INBOX' AND is_read = 0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let starred_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM emails WHERE starred = 1", [], |r| r.get(0))
        .unwrap_or(0);
    let sent_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM emails WHERE mailbox = 'SENT'", [], |r| r.get(0))
        .unwrap_or(0);
    let drafts_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM emails WHERE mailbox = 'DRAFT'", [], |r| r.get(0))
        .unwrap_or(0);
    let archive_total: i64 = conn
        .query_row("SELECT COUNT(*) FROM emails WHERE mailbox = 'ARCHIVE'", [], |r| r.get(0))
        .unwrap_or(0);

    Ok(MailboxCounts {
        inbox_total,
        inbox_unread,
        starred_total,
        sent_total,
        drafts_total,
        archive_total,
    })
}

#[tauri::command]
async fn get_user_profile(state: State<'_, DbState>) -> Result<UserProfile, String> {
    let token = ensure_token(&state).await?.access_token;
    let client = reqwest::Client::new();

    let res = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Profile request failed: {}", res.status()));
    }

    let body = res.json::<Value>().await.map_err(|e| e.to_string())?;
    let email = body
        .get("emailAddress")
        .and_then(Value::as_str)
        .unwrap_or("unknown@example.com")
        .to_string();

    let name = email.split('@').next().unwrap_or("User").replace('.', " ");
    let initials = name
        .split_whitespace()
        .take(2)
        .filter_map(|p| p.chars().next())
        .collect::<String>()
        .to_uppercase();

    Ok(UserProfile {
        name,
        email,
        initials: if initials.is_empty() { "U".to_string() } else { initials },
    })
}

#[tauri::command]
async fn logout(state: State<'_, DbState>) -> Result<(), String> {
    {
        let mut cache = state.token.lock().await;
        *cache = None;
    }
    let conn = state.conn.lock().await;
    clear_tokens(&conn).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn clear_local_data(state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.lock().await;
    clear_emails(&conn).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn send_email(
    state: State<'_, DbState>,
    to: String,
    cc: String,
    subject: String,
    body: String,
    mode: String,
    body_html: Option<String>,
    attachments: Vec<EmailAttachment>,
) -> Result<(), String> {
    let token = ensure_token(&state).await?.access_token;
    let encoded = build_raw_mime_message(to, cc, subject, body, mode, body_html, attachments)?;

    let client = reqwest::Client::new();
    let res = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .bearer_auth(&token)
        .json(&json!({ "raw": encoded }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("Error: {}", res.status()))
    }
}

#[tauri::command]
async fn save_draft(
    state: State<'_, DbState>,
    to: String,
    cc: String,
    subject: String,
    body: String,
    mode: String,
    body_html: Option<String>,
    attachments: Vec<EmailAttachment>,
    draft_id: Option<String>,
) -> Result<DraftSaveResult, String> {
    let token = ensure_token(&state).await?.access_token;
    let encoded = build_raw_mime_message(to, cc, subject, body, mode, body_html, attachments)?;

    let client = reqwest::Client::new();
    let payload = json!({
        "message": { "raw": encoded }
    });

    let res = if let Some(existing_id) = draft_id.clone().filter(|d| !d.trim().is_empty()) {
        client
            .put(format!("https://gmail.googleapis.com/gmail/v1/users/me/drafts/{}", existing_id))
            .bearer_auth(&token)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?
    } else {
        client
            .post("https://gmail.googleapis.com/gmail/v1/users/me/drafts")
            .bearer_auth(&token)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?
    };

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Draft save failed: {} {}", status, body));
    }

    let data = res.json::<Value>().await.map_err(|e| e.to_string())?;
    let saved_draft_id = data
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Draft save returned no draft id".to_string())?;

    sync_mailbox_internal(&state, "DRAFT").await?;

    Ok(DraftSaveResult {
        draft_id: saved_draft_id,
    })
}

#[tauri::command]
async fn send_existing_draft(state: State<'_, DbState>, draft_id: String) -> Result<(), String> {
    let token = ensure_token(&state).await?.access_token;
    let client = reqwest::Client::new();
    let draft_id_clean = draft_id.trim().to_string();

    let res = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send")
        .bearer_auth(&token)
        .json(&json!({ "id": draft_id_clean }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Draft send failed: {} {}", status, body));
    }

    // Gmail returns the sent message; use it to aggressively clear local draft state.
    let sent_msg = res.json::<Value>().await.ok();
    let sent_message_id = sent_msg
        .as_ref()
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);

    {
        let conn = state.conn.lock().await;
        if let Some(message_id) = sent_message_id {
            let _ = conn.execute(
                "DELETE FROM emails WHERE mailbox = 'DRAFT' AND (draft_id = ?1 OR id = ?2)",
                (&draft_id_clean, &message_id),
            );
        } else {
            let _ = conn.execute(
                "DELETE FROM emails WHERE mailbox = 'DRAFT' AND draft_id = ?1",
                [&draft_id_clean],
            );
        }
    }

    let _ = sync_mailbox_internal(&state, "DRAFT").await;
    let _ = sync_mailbox_internal(&state, "SENT").await;

    Ok(())
}

#[tauri::command]
async fn download_attachment(
    state: State<'_, DbState>,
    email_id: String,
    attachment_id: String,
    filename: String,
    content_type: String,
) -> Result<AttachmentDownload, String> {
    let token = ensure_token(&state).await?.access_token;
    let client = reqwest::Client::new();
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/attachments/{}",
        email_id.trim(),
        attachment_id.trim()
    );

    let res = client
        .get(url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Attachment download failed: {} {}", status, body));
    }

    let json = res.json::<Value>().await.map_err(|e| e.to_string())?;
    let encoded = json
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "Attachment data missing".to_string())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(AttachmentDownload {
        filename,
        content_type: if content_type.trim().is_empty() {
            "application/octet-stream".to_string()
        } else {
            content_type
        },
        data_base64: STANDARD.encode(bytes),
    })
}

#[tauri::command]
async fn auth_status(state: State<'_, DbState>) -> Result<AuthStatus, String> {
    let has_client_id = auth::has_google_client_id_configured();

    let connected = {
        if state.token.lock().await.is_some() {
            true
        } else {
            let conn = state.conn.lock().await;
            get_token(&conn).map_err(|e| e.to_string())?.is_some()
        }
    };

    Ok(AuthStatus {
        has_client_id,
        connected,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::from_filename("../.env").or_else(|_| dotenvy::from_filename(".env"));

    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()
                .expect("Failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir)
                .expect("Failed to create app data dir");
            let db_path = data_dir.join("emails.db");

            let conn = Connection::open(&db_path).expect("Failed to open DB");
            init_db(&conn).expect("Failed to init DB");

            app.manage(DbState {
                conn: Mutex::new(conn),
                token: Mutex::new(None),
            });

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_gmail,
            sync_emails,
            sync_mailbox,
            sync_mailbox_page,
            get_emails,
            deep_search_emails,
            set_email_read_status,
            toggle_starred,
            archive_email,
            trash_email,
            get_mailbox_counts,
            get_user_profile,
            logout,
            clear_local_data,
            send_email,
            save_draft,
            send_existing_draft,
            download_attachment,
            auth_status,
            check_for_updates,
            download_latest_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}