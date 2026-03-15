mod db;
mod auth;

use db::{get_token, init_db, upsert_token, Email, StoredToken};
use rusqlite::Connection;
use tokio::sync::Mutex;
use tauri::State;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

struct DbState {
    conn: Mutex<Connection>,
    token: Mutex<Option<StoredToken>>,
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

fn extract_body(payload: &Value) -> Option<String> {
    let mime = payload.get("mimeType").and_then(Value::as_str).unwrap_or_default();
    let body_data = payload
        .get("body")
        .and_then(|b| b.get("data"))
        .and_then(Value::as_str);

    if let Some(data) = body_data {
        let decoded = decode_gmail_base64(data)?;
        if mime.eq_ignore_ascii_case("text/html") {
            return Some(decoded);
        }
        if mime.eq_ignore_ascii_case("text/plain") {
            return Some(format!("<pre>{}</pre>", decoded));
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

#[tauri::command]
async fn sync_emails(state: State<'_, DbState>) -> Result<(), String> {
    let client = reqwest::Client::new();
    let mut token = ensure_token(&state).await?.access_token;
    let mut last_error = None;

    let mut json_opt: Option<Value> = None;
    for _ in 0..2 {
        let res = client
            .get("https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=50")
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if res.status().as_u16() == 401 {
            {
                let mut cache = state.token.lock().await;
                *cache = None;
            }
            token = ensure_token(&state).await?.access_token;
            continue;
        }

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            last_error = Some(format!("Gmail list API failed: {} {}", status, body));
            break;
        }

        json_opt = Some(res.json::<Value>().await.map_err(|e| e.to_string())?);
        break;
    }

    let json = match json_opt {
        Some(v) => v,
        None => return Err(last_error.unwrap_or_else(|| "Unable to list Gmail messages".to_string())),
    };

    let messages = json
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for msg in messages {
        let Some(id) = msg.get("id").and_then(Value::as_str) else {
            continue;
        };

        let detail_url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=full", id);
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

        let snippet = detail_json
            .get("snippet")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        let headers = detail_json
            .get("payload")
            .and_then(|p| p.get("headers"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let subject = header_value(&headers, "Subject").unwrap_or_else(|| "(No Subject)".to_string());
        let sender = header_value(&headers, "From").unwrap_or_else(|| "Unknown Sender".to_string());
        let date = header_value(&headers, "Date").unwrap_or_else(|| "Unknown Date".to_string());

        let body_html = detail_json
            .get("payload")
            .and_then(extract_body)
            .unwrap_or_else(|| format!("<pre>{}</pre>", snippet));

        let is_read = !detail_json
            .get("labelIds")
            .and_then(Value::as_array)
            .map(|labels| labels.iter().any(|v| v.as_str() == Some("UNREAD")))
            .unwrap_or(false);

        let conn = state.conn.lock().await;
        conn.execute(
            "INSERT INTO emails (id, thread_id, subject, sender, snippet, body_html, date, is_read)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id)
             DO UPDATE SET
                thread_id = excluded.thread_id,
                subject = excluded.subject,
                sender = excluded.sender,
                snippet = excluded.snippet,
                body_html = excluded.body_html,
                date = excluded.date,
                is_read = excluded.is_read",
            (
                id,
                &thread_id,
                &subject,
                &sender,
                &snippet,
                &body_html,
                &date,
                is_read as i32,
            ),
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn get_emails(state: State<'_, DbState>) -> Result<Vec<Email>, String> {
    let conn = state.conn.lock().await;
    let mut stmt = conn
        .prepare(
            "SELECT id, thread_id, subject, sender, snippet, body_html, date, is_read
             FROM emails
             ORDER BY rowid DESC
             LIMIT 100",
        )
        .map_err(|e| e.to_string())?;

    let emails = stmt.query_map([], |row| {
        Ok(Email {
            id: row.get(0)?,
            thread_id: row.get(1)?,
            subject: row.get(2)?,
            sender: row.get(3)?,
            snippet: row.get(4)?,
            body_html: row.get(5)?,
            date: row.get(6)?,
            is_read: row.get::<_, i32>(7)? != 0,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(Result::ok)
    .collect();
    Ok(emails)
}

#[tauri::command]
async fn send_email(state: State<'_, DbState>, to: String, subject: String, body: String) -> Result<(), String> {
    let token = ensure_token(&state).await?.access_token;

    let raw_message = format!(
        "To: {}\r\nSubject: {}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{}",
        to, subject, body
    );
    let encoded = URL_SAFE_NO_PAD.encode(raw_message.as_bytes());

    let client = reqwest::Client::new();
    let res = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .bearer_auth(&token)
        .json(&serde_json::json!({ "raw": encoded }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("Error: {}", res.status()))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Try root-level .env first (npm run tauri dev from workspace root), then local src-tauri/.env.
    let _ = dotenvy::from_filename("../.env").or_else(|_| dotenvy::from_filename(".env"));

    let conn = Connection::open("emails.db").expect("Failed to open DB");
    init_db(&conn).expect("Failed to init DB");

    tauri::Builder::default()
        .manage(DbState { conn: Mutex::new(conn), token: Mutex::new(None) })
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
        .invoke_handler(tauri::generate_handler![sync_emails, get_emails, send_email])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
