use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

use crate::db::{get_all_accounts, Account};
use crate::state::DbState;

const SYNC_INTERVAL_SECS: u64 = 45;
const IMAP_MAILBOXES: &[&str] = &["INBOX", "SENT", "DRAFT"];


pub async fn start_all_sync_tasks(state: Arc<DbState>) {
    let accounts = {
        let conn = state.conn.lock().await;
        get_all_accounts(&conn).unwrap_or_default()
    };

    for account in accounts {
        start_account_sync(state.clone(), account).await;
    }
}


pub async fn start_account_sync(state: Arc<DbState>, account: Account) {
    let account_id = account.id;

    
    stop_account_sync(&state, account_id).await;

    let (tx, rx) = oneshot::channel::<()>();

    {
        let mut handles = state.sync_handles.lock().await;
        handles.insert(account_id, tx);
    }

    let state_clone = state.clone();
    tokio::spawn(async move {
        run_sync_loop(state_clone, account, rx).await;
    });
}


pub async fn stop_account_sync(state: &DbState, account_id: i64) {
    let mut handles = state.sync_handles.lock().await;
    if let Some(tx) = handles.remove(&account_id) {
        let _ = tx.send(());
    }
}

async fn run_sync_loop(
    state: Arc<DbState>,
    account: Account,
    mut shutdown: oneshot::Receiver<()>,
) {
    
    sync_account(&state, &account).await;

    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(SYNC_INTERVAL_SECS)) => {
                
                let fresh_account = {
                    let conn = state.conn.lock().await;
                    crate::db::get_account_by_id(&conn, account.id)
                        .ok()
                        .flatten()
                };
                if let Some(acc) = fresh_account {
                    sync_account(&state, &acc).await;
                } else {
                    
                    break;
                }
            }
            _ = &mut shutdown => {
                break;
            }
        }
    }
}

async fn sync_account(state: &DbState, account: &Account) {
    match account.provider.as_str() {
        "gmail" => sync_gmail_account(state, account).await,
        "imap" => sync_imap_account(state, account).await,
        _ => {}
    }
}

async fn sync_gmail_account(state: &DbState, account: &Account) {
    use crate::commands::mail::sync_mailbox_internal_for;

    let mailboxes = ["INBOX", "SENT", "DRAFT"];
    for mailbox in &mailboxes {
        if let Err(e) = sync_mailbox_internal_for(state, account.id, mailbox).await {
            log::error!("Gmail sync error account={} mailbox={}: {}", account.id, mailbox, e);
        }
    }
}

async fn sync_imap_account(state: &DbState, account: &Account) {
    use crate::imap_sync::sync_imap_mailbox;

    let account_clone = account.clone();
    let account_id = account.id;

    for mailbox in IMAP_MAILBOXES {
        let acc = account_clone.clone();
        let mb = mailbox.to_string();

        let result = tokio::task::spawn_blocking(move || {
            sync_imap_mailbox(&acc, &mb, 50)
        }).await;

        match result {
            Ok(Ok(emails)) => {
                upsert_emails(state, account_id, emails).await;
            }
            Ok(Err(e)) => {
                log::error!("IMAP sync error account={} mailbox={}: {}", account_id, mailbox, e);
            }
            Err(e) => {
                log::error!("IMAP sync task panicked account={}: {}", account_id, e);
            }
        }
    }
}

async fn upsert_emails(state: &DbState, account_id: i64, emails: Vec<crate::db::Email>) {
    let conn = state.conn.lock().await;
    for email in emails {
        let _ = conn.execute(
            "INSERT INTO emails (id, account_id, draft_id, thread_id, subject, sender, to_recipients, cc_recipients,
                                 snippet, body_html, attachments_json, has_attachments, date, is_read, starred,
                                 mailbox, labels, internal_ts, uid, message_id_header)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
            ON CONFLICT(id, account_id) DO UPDATE SET
                snippet = excluded.snippet,
                body_html = excluded.body_html,
                is_read = excluded.is_read,
                starred = excluded.starred,
                mailbox = excluded.mailbox,
                labels = excluded.labels,
                internal_ts = excluded.internal_ts,
                uid = excluded.uid,
                message_id_header = excluded.message_id_header,
                attachments_json = CASE 
                    WHEN excluded.attachments_json = '[]' OR excluded.attachments_json = '' 
                    THEN emails.attachments_json 
                    ELSE excluded.attachments_json 
                END,
                has_attachments = CASE
                    WHEN excluded.attachments_json = '[]' OR excluded.attachments_json = ''
                    THEN emails.has_attachments
                    ELSE excluded.has_attachments
                END",
            rusqlite::params![
                email.id, email.account_id, email.draft_id, email.thread_id,
                email.subject, email.sender, email.to_recipients, email.cc_recipients,
                email.snippet, email.body_html, email.attachments_json,
                email.has_attachments as i32, email.date, email.is_read as i32,
                email.starred as i32, email.mailbox, email.labels, email.internal_ts,
                email.uid, email.message_id_header
            ],
        );
    }
}
