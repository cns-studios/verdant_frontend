mod auth;
mod db;

use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use db::{clear_emails, clear_tokens, get_token, init_db, upsert_token, Email, StoredToken};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::sync::Mutex;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailAttachment {
    filename: String,
    #[serde(default)]
    content_type: String,
    data_base64: String,
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

async fn sync_mailbox_internal(state: &DbState, mailbox: &str) -> Result<(), String> {
    let Some(label) = mailbox_label(mailbox) else {
        return Ok(());
    };

    let client = reqwest::Client::new();
    let token = ensure_token(state).await?.access_token;

    let list_url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds={}&maxResults=50",
        label
    );
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
    let messages = json
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for msg in messages {
        let Some(id) = msg.get("id").and_then(Value::as_str) else {
            continue;
        };

        // Fast path for existing emails: keep metadata fresh but skip full-body fetch.
        let exists = {
            let conn = state.conn.lock().await;
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM emails WHERE id = ?1", [id], |r| r.get(0))
                .unwrap_or(0);
            count > 0
        };

        let detail_url = if exists {
            format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date",
                id
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

        let detail_json = detail.json::<Value>().await.map_err(|e| e.to_string())?;

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

        let body_html = if exists {
            let conn = state.conn.lock().await;
            conn.query_row("SELECT body_html FROM emails WHERE id = ?1", [id], |r| r.get::<_, String>(0))
                .unwrap_or_else(|_| format!("<pre>{}</pre>", snippet))
        } else {
            detail_json
                .get("payload")
                .and_then(extract_body)
                .unwrap_or_else(|| format!("<pre>{}</pre>", snippet))
        };

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
            "INSERT INTO emails (id, thread_id, subject, sender, to_recipients, cc_recipients, snippet, body_html, date, is_read, mailbox, labels, internal_ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id)
             DO UPDATE SET
                thread_id = excluded.thread_id,
                subject = excluded.subject,
                sender = excluded.sender,
                to_recipients = excluded.to_recipients,
                cc_recipients = excluded.cc_recipients,
                snippet = excluded.snippet,
                body_html = excluded.body_html,
                date = excluded.date,
                mailbox = excluded.mailbox,
                labels = excluded.labels,
                internal_ts = excluded.internal_ts",
            (
                id,
                &thread_id,
                &subject,
                &sender,
                &to_recipients,
                &cc_recipients,
                &snippet,
                &body_html,
                &date,
                is_read as i32,
                mailbox,
                &labels,
                internal_ts,
            ),
        )
        .map_err(|e| e.to_string())?;
    }

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
async fn get_emails(
    state: State<'_, DbState>,
    mailbox: Option<String>,
) -> Result<Vec<Email>, String> {
    let box_name = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let conn = state.conn.lock().await;

    let sql = if box_name == "STARRED" {
        "SELECT id, thread_id, subject, sender, to_recipients, cc_recipients, snippet, body_html, date, is_read, starred, mailbox, labels, internal_ts
         FROM emails WHERE starred = 1 ORDER BY internal_ts DESC, rowid DESC LIMIT 500"
    } else {
        "SELECT id, thread_id, subject, sender, to_recipients, cc_recipients, snippet, body_html, date, is_read, starred, mailbox, labels, internal_ts
         FROM emails WHERE mailbox = ?1 ORDER BY internal_ts DESC, rowid DESC LIMIT 500"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(Email {
            id: row.get(0)?,
            thread_id: row.get(1)?,
            subject: row.get(2)?,
            sender: row.get(3)?,
            to_recipients: row.get(4)?,
            cc_recipients: row.get(5)?,
            snippet: row.get(6)?,
            body_html: row.get(7)?,
            date: row.get(8)?,
            is_read: row.get::<_, i32>(9)? != 0,
            starred: row.get::<_, i32>(10)? != 0,
            mailbox: row.get(11)?,
            labels: row.get(12)?,
            internal_ts: row.get(13)?,
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
    raw_message.push_str(&format!("To: {}\r\n", to));
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

    let encoded = URL_SAFE_NO_PAD.encode(raw_message.as_bytes());

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
async fn auth_status(state: State<'_, DbState>) -> Result<AuthStatus, String> {
    let has_client_id = std::env::var("GOOGLE_CLIENT_ID")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

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

    let conn = Connection::open("emails.db").expect("Failed to open DB");
    init_db(&conn).expect("Failed to init DB");

    tauri::Builder::default()
        .manage(DbState {
            conn: Mutex::new(conn),
            token: Mutex::new(None),
        })
        .setup(|app| {
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
            get_emails,
            set_email_read_status,
            toggle_starred,
            archive_email,
            trash_email,
            get_mailbox_counts,
            get_user_profile,
            logout,
            clear_local_data,
            send_email,
            auth_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
