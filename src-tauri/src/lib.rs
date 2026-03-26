mod auth;
mod background_sync;
mod commands;
mod crypto;
mod db;
mod gmail;
mod imap_sync;
mod mime;
mod smtp_send;
mod state;

use std::collections::HashMap;
use std::sync::Arc;

use db::init_db;
use rusqlite::Connection;
use state::DbState;
use tauri::Manager;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::from_filename("../.env").or_else(|_| dotenvy::from_filename(".env"));

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("Failed to create app data dir");
            let db_path = data_dir.join("emails.db");

            let conn = Connection::open(&db_path).expect("Failed to open DB");
            init_db(&conn).expect("Failed to init DB");

            
            let initial_active_id = db::get_active_account(&conn)
                .ok()
                .flatten()
                .map(|a| a.id)
                .unwrap_or(0);

            let state = Arc::new(DbState {
                conn: Mutex::new(conn),
                tokens: Mutex::new(HashMap::new()),
                active_account_id: Mutex::new(initial_active_id),
                sync_handles: Mutex::new(HashMap::new()),
            });

            app.manage(state.clone());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            
            let state_for_sync = state.clone();
            tauri::async_runtime::spawn(async move {
                background_sync::start_all_sync_tasks(state_for_sync).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            
            commands::auth::connect_gmail,
            commands::auth::auth_status,
            commands::auth::logout,
            commands::auth::get_user_profile,
            
            commands::accounts::list_accounts,
            commands::accounts::switch_account,
            commands::accounts::remove_account,
            commands::accounts::add_gmail_account,
            commands::accounts::add_imap_account,
            commands::accounts::add_gmx_account,
            commands::accounts::test_imap_credentials,
            commands::accounts::get_active_account_info,
            
            commands::mail::sync_emails,
            commands::mail::sync_mailbox,
            commands::mail::sync_mailbox_page,
            commands::mail::get_emails,
            commands::mail::deep_search_emails,
            commands::mail::set_email_read_status,
            commands::mail::toggle_starred,
            commands::mail::archive_email,
            commands::mail::trash_email,
            commands::mail::get_mailbox_counts,
            commands::mail::clear_local_data,
            commands::mail::get_inbox_threads,
            commands::mail::get_thread_messages,
            commands::mail::mark_thread_read,
            commands::mail::remove_label,
            
            commands::compose::send_email,
            commands::compose::save_draft,
            commands::compose::send_existing_draft,
            
            commands::attachments::download_attachment,
            
            commands::updater::check_for_updates,
            commands::updater::download_latest_update,
            commands::updater::install_and_relaunch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
