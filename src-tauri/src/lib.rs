mod db;
mod auth;
use db::{init_db, Email};
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::State;

struct DbState {
    conn: Mutex<Connection>,
}

#[tauri::command]
fn get_emails(state: State<'_, DbState>) -> Result<Vec<Email>, String> {
    let _ = auth::run_auth_flow();
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id, thread_id, subject, sender, body_html, date, is_read FROM emails").map_err(|e| e.to_string())?;
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
fn sync_emails(state: State<'_, DbState>) -> Result<(), String> {
    let _ = auth::run_auth_flow();
    let conn = state.conn.lock().unwrap();
    let count: i32 = conn.query_row("SELECT COUNT(*) FROM emails", [], |row| row.get(0)).unwrap_or(0);
    if count == 0 {
        conn.execute("INSERT INTO emails (id, thread_id, subject, sender, body_html, date, is_read) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            ("1", "t1", "Welcome to Verdant", "foo@example.com", "<h1>Hello</h1>", "2026-03-15", 0)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn send_email(_to: String, _subject: String, _body: String) -> Result<(), String> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = Connection::open("emails.db").expect("Failed to open DB");
    init_db(&conn).expect("Failed to init DB");

    tauri::Builder::default()
        .manage(DbState { conn: Mutex::new(conn) })
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
        .invoke_handler(tauri::generate_handler![get_emails, sync_emails, send_email])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
