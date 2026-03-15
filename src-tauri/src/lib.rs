mod db;
mod auth;

use db::{init_db, Email};
use rusqlite::Connection;
use tokio::sync::Mutex;
use tauri::State;
use serde_json::Value;

struct DbState {
    conn: Mutex<Connection>,
    token: Mutex<Option<String>>,
}

#[tauri::command]
async fn sync_emails(state: State<'_, DbState>) -> Result<(), String> {
    let mut token_val = None;
    {
        let token_guard = state.token.lock().await;
        token_val = token_guard.clone();
    }
    
    if token_val.is_none() {
        let new_token = auth::run_auth_flow().await.map_err(|e| e.to_string())?;
        let mut token_guard = state.token.lock().await;
        *token_guard = Some(new_token.clone());
        token_val = Some(new_token);
    }
    let token = token_val.unwrap();

    let client = reqwest::Client::new();
    let res = client.get("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10")
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())?;

    let messages = res["messages"].as_array().ok_or("No messages")?;

    for msg in messages {
        let id = msg["id"].as_str().unwrap();
        // check if exist
        let exists = {
            let conn = state.conn.lock().await;
            let count: i32 = conn.query_row("SELECT COUNT(*) FROM emails WHERE id = ?1", [id], |row| row.get(0)).unwrap_or(0);
            count > 0
        };
        
        if exists { continue; }

        let detail_res = client.get(&format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}", id))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json::<Value>()
            .await
            .map_err(|e| e.to_string())?;

        let thread_id = detail_res["threadId"].as_str().unwrap_or("").to_string();
        let snippet = detail_res["snippet"].as_str().unwrap_or("").to_string();
        
        let mut subject = "No Subject".to_string();
        let mut sender = "Unknown".to_string();
        let mut date = "Unknown Date".to_string();

        if let Some(headers) = detail_res["payload"]["headers"].as_array() {
            for h in headers {
                if h["name"] == "Subject" { subject = h["value"].as_str().unwrap_or("").to_string(); }
                if h["name"] == "From" { sender = h["value"].as_str().unwrap_or("").to_string(); }
                if h["name"] == "Date" { date = h["value"].as_str().unwrap_or("").to_string(); }
            }
        }

        let is_read = !detail_res["labelIds"].as_array().unwrap_or(&vec![]).iter().any(|v| v == "UNREAD");

        let conn = state.conn.lock().await;
        conn.execute(
            "INSERT INTO emails (id, thread_id, subject, sender, body_html, date, is_read) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (id, &thread_id, &subject, &sender, &snippet, &date, is_read as i32),
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_emails(state: State<'_, DbState>) -> Result<Vec<Email>, String> {
    let conn = state.conn.lock().await;
    let mut stmt = conn.prepare("SELECT id, thread_id, subject, sender, body_html, date, is_read FROM emails ORDER BY rowid DESC LIMIT 50").map_err(|e| e.to_string())?;
    let emails = stmt.query_map([], |row| {
        Ok(Email {
            id: row.get(0)?,
            thread_id: row.get(1)?,
            subject: row.get(2)?,
            sender: row.get(3)?,
            body_html: row.get(4)?,
            date: row.get(5)?,
            is_read: row.get::<_, i32>(6)? != 0,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(Result::ok)
    .collect();
    Ok(emails)
}

#[tauri::command]
async fn send_email(state: State<'_, DbState>, to: String, subject: String, body: String) -> Result<(), String> {
    let token = {
        let token_guard = state.token.lock().await;
        token_guard.as_ref().ok_or("Not authenticated")?.clone()
    };

    let raw_message = format!("To: {}\r\nSubject: {}\r\n\r\n{}", to, subject, body);
    use base64::{Engine as _, engine::general_purpose};
    let encoded = general_purpose::URL_SAFE.encode(raw_message);

    let client = reqwest::Client::new();
    let res = client.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
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
