use std::sync::Arc;
use serde_json::{json, Value};
use tauri::State;

use crate::db::{clear_account_emails, Email};
use crate::gmail::{
    collect_attachments, extract_body, header_value, mailbox_from_labels, mailbox_label,
    strip_confusable_chars, AttachmentMeta,
};
use crate::state::{ensure_token, ensure_token_for, DbState, get_active_id};

#[derive(serde::Serialize)]
pub struct MailboxCounts {
    pub inbox_total: i64,
    pub inbox_unread: i64,
    pub starred_total: i64,
    pub sent_total: i64,
    pub drafts_total: i64,
    pub archive_total: i64,
}



pub async fn sync_mailbox_page_internal_for(
    state: &DbState,
    account_id: i64,
    mailbox: &str,
    page_token: Option<String>,
) -> Result<Option<String>, String> {
    let Some(label) = mailbox_label(mailbox) else {
        return Ok(None);
    };

    let client = reqwest::Client::new();
    let token = ensure_token_for(state, account_id).await?.access_token;

    let mut list_url = if mailbox == "DRAFT" {
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=50".to_string()
    } else {
        format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds={}&maxResults=50",
            label
        )
    };
    if let Some(pt) = page_token {
        if !pt.trim().is_empty() {
            list_url.push_str("&pageToken=");
            list_url.push_str(pt.trim());
        }
    }

    let res = client.get(&list_url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Gmail list API failed: {} {}", status, body));
    }

    let json = res.json::<Value>().await.map_err(|e| e.to_string())?;
    let next_page_token = json.get("nextPageToken").and_then(Value::as_str).map(str::to_string);

    let message_refs: Vec<(String, Option<String>)> = if mailbox == "DRAFT" {
        json.get("drafts").and_then(Value::as_array).map(|drafts| {
            drafts.iter().filter_map(|draft| {
                let draft_id = draft.get("id").and_then(Value::as_str)?.to_string();
                let message_id = draft.get("message").and_then(|m| m.get("id")).and_then(Value::as_str)?.to_string();
                Some((message_id, Some(draft_id)))
            }).collect::<Vec<_>>()
        }).unwrap_or_default()
    } else {
        json.get("messages").and_then(Value::as_array).map(|messages| {
            messages.iter().filter_map(|msg| {
                msg.get("id").and_then(Value::as_str).map(|id| (id.to_string(), None))
            }).collect::<Vec<_>>()
        }).unwrap_or_default()
    };

    for (id, draft_id) in message_refs {
        if id.is_empty() { continue; }

        let composite_id = format!("{}:{}", account_id, id);

        let detail_url = if mailbox == "DRAFT" {
            format!("https://gmail.googleapis.com/gmail/v1/users/me/drafts/{}?format=full", draft_id.clone().unwrap_or_default())
        } else {
            format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=full", id)
        };

        let detail = client.get(detail_url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
        if !detail.status().is_success() { continue; }

        let raw_detail = detail.json::<Value>().await.map_err(|e| e.to_string())?;
        let detail_json = if mailbox == "DRAFT" {
            raw_detail.get("message").cloned().unwrap_or_else(|| json!({}))
        } else {
            raw_detail.clone()
        };

        let resolved_draft_id = if mailbox == "DRAFT" {
            draft_id.clone().or_else(|| raw_detail.get("id").and_then(Value::as_str).map(str::to_string))
        } else {
            None
        };

        let thread_id = detail_json.get("threadId").and_then(Value::as_str).unwrap_or_default().to_string();
        let snippet = strip_confusable_chars(detail_json.get("snippet").and_then(Value::as_str).unwrap_or_default());

        let headers = detail_json.get("payload").and_then(|p| p.get("headers")).and_then(Value::as_array).cloned().unwrap_or_default();
        let subject = strip_confusable_chars(&header_value(&headers, "Subject").unwrap_or_else(|| "(No Subject)".to_string()));
        let sender = strip_confusable_chars(&header_value(&headers, "From").unwrap_or_else(|| "Unknown Sender".to_string()));
        let to_recipients = strip_confusable_chars(&header_value(&headers, "To").unwrap_or_default());
        let cc_recipients = strip_confusable_chars(&header_value(&headers, "Cc").unwrap_or_default());
        let date = header_value(&headers, "Date").unwrap_or_else(|| "Unknown Date".to_string());
        let message_id_header = header_value(&headers, "Message-ID");
        let internal_ts = detail_json.get("internalDate").and_then(Value::as_str).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);

        let (existing_body, existing_attachments) = {
            let conn = state.conn.lock().await;
            let body = conn.query_row("SELECT body_html FROM emails WHERE id = ?1 AND account_id = ?2", [composite_id.as_str(), &account_id.to_string()], |r| r.get::<_, String>(0)).ok();
            let att = conn.query_row("SELECT attachments_json FROM emails WHERE id = ?1 AND account_id = ?2", [composite_id.as_str(), &account_id.to_string()], |r| r.get::<_, String>(0)).ok();
            (body, att)
        };

        let body_html = detail_json.get("payload").and_then(extract_body)
            .or(existing_body)
            .unwrap_or_else(|| format!("<pre>{}</pre>", snippet));

        let mut attachments: Vec<AttachmentMeta> = Vec::new();
        if let Some(payload) = detail_json.get("payload") {
            collect_attachments(payload, &mut attachments);
        }
        let attachments_json = if attachments.is_empty() {
            existing_attachments.unwrap_or_else(|| "[]".to_string())
        } else {
            serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".to_string())
        };
        let has_attachments = !attachments_json.trim().is_empty() && attachments_json.trim() != "[]";

        let labels = detail_json.get("labelIds").and_then(Value::as_array).map(|a| {
            a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")
        }).unwrap_or_default();
        let is_read = !labels.split(',').any(|l| l == "UNREAD");

        let conn = state.conn.lock().await;
        conn.execute(
            "INSERT INTO emails (id, account_id, draft_id, thread_id, subject, sender, to_recipients, cc_recipients,
                                 snippet, body_html, attachments_json, has_attachments, date, is_read, mailbox, labels, internal_ts, uid, message_id_header)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
             ON CONFLICT(id, account_id) DO UPDATE SET
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
                internal_ts = excluded.internal_ts,
                uid = excluded.uid,
                message_id_header = excluded.message_id_header",
            rusqlite::params![
                composite_id, account_id, resolved_draft_id, thread_id,
                subject, sender, to_recipients, cc_recipients,
                snippet, body_html, attachments_json, has_attachments as i32,
                date, is_read as i32, mailbox, labels, internal_ts,
                rusqlite::types::Null, message_id_header
            ],
        ).map_err(|e| e.to_string())?;
    }

    Ok(next_page_token)
}

pub async fn sync_mailbox_internal_for(state: &DbState, account_id: i64, mailbox: &str) -> Result<(), String> {
    sync_mailbox_page_internal_for(state, account_id, mailbox, None).await.map(|_| ())
}



#[tauri::command]
pub async fn sync_emails(state: State<'_, Arc<DbState>>) -> Result<(), String> {
    let id = get_active_id(&state).await;
    sync_mailbox_internal_for(&state, id, "INBOX").await
}

#[tauri::command]
pub async fn sync_mailbox(state: State<'_, Arc<DbState>>, mailbox: String) -> Result<(), String> {
    let id = get_active_id(&state).await;
    sync_mailbox_internal_for(&state, id, mailbox.as_str()).await
}

#[tauri::command]
pub async fn sync_mailbox_page(
    state: State<'_, Arc<DbState>>,
    mailbox: String,
    page_token: Option<String>,
) -> Result<Option<String>, String> {
    let id = get_active_id(&state).await;
    sync_mailbox_page_internal_for(&state, id, mailbox.as_str(), page_token).await
}

fn map_email_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Email> {
    Ok(Email {
        id: row.get(0)?,
        account_id: row.get(1)?,
        draft_id: row.get(2)?,
        thread_id: row.get(3)?,
        subject: row.get(4)?,
        sender: row.get(5)?,
        to_recipients: row.get(6)?,
        cc_recipients: row.get(7)?,
        snippet: row.get(8)?,
        body_html: row.get(9)?,
        attachments_json: row.get(10)?,
        has_attachments: row.get::<_, i32>(11)? != 0,
        date: row.get(12)?,
        is_read: row.get::<_, i32>(13)? != 0,
        starred: row.get::<_, i32>(14)? != 0,
        mailbox: row.get(15)?,
        labels: row.get(16)?,
        internal_ts: row.get(17)?,
        uid: row.get(18)?,
        message_id_header: row.get(19)?,
    })
}

#[tauri::command]
pub async fn get_emails(
    state: State<'_, Arc<DbState>>,
    mailbox: Option<String>,
) -> Result<Vec<Email>, String> {
    let account_id = get_active_id(&state).await;
    let box_name = mailbox.unwrap_or_else(|| "INBOX".to_string());
    let conn = state.conn.lock().await;

    let emails = if box_name == "STARRED" {
        let mut stmt = conn.prepare(
            "SELECT id,account_id,draft_id,thread_id,subject,sender,to_recipients,cc_recipients,
                    snippet,body_html,attachments_json,has_attachments,date,is_read,starred,mailbox,labels,internal_ts,uid,message_id_header
             FROM emails WHERE starred=1 AND account_id=?1 ORDER BY internal_ts DESC, rowid DESC LIMIT 500"
        ).map_err(|e| e.to_string())?;
        let x = stmt.query_map([account_id], map_email_row).map_err(|e| e.to_string())?
            .filter_map(Result::ok).collect(); x
    } else {
        let mut stmt = conn.prepare(
            "SELECT id,account_id,draft_id,thread_id,subject,sender,to_recipients,cc_recipients,
                    snippet,body_html,attachments_json,has_attachments,date,is_read,starred,mailbox,labels,internal_ts,uid,message_id_header
             FROM emails WHERE mailbox=?1 AND account_id=?2 ORDER BY internal_ts DESC, rowid DESC LIMIT 500"
        ).map_err(|e| e.to_string())?;
        let x = stmt.query_map(rusqlite::params![box_name, account_id], map_email_row)
            .map_err(|e| e.to_string())?.filter_map(Result::ok).collect(); x
    };

    Ok(emails)
}

#[tauri::command]
pub async fn deep_search_emails(
    state: State<'_, Arc<DbState>>,
    query: String,
) -> Result<Vec<Email>, String> {
    let account_id = get_active_id(&state).await;

    let is_gmail = {
        let conn = state.conn.lock().await;
        crate::db::get_account_by_id(&conn, account_id)
            .ok().flatten()
            .map(|a| a.provider == "gmail")
            .unwrap_or(false)
    };

    if !is_gmail {
        return Err("Deep search is only supported for Gmail accounts".to_string());
    }

    let token = ensure_token(&state).await?.access_token;
    let client = reqwest::Client::new();
    let q = format!("in:anywhere {}", query.trim());

    let list = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .query(&[("maxResults", "100"), ("q", q.as_str())])
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;

    if !list.status().is_success() {
        return Err(format!("Deep search failed: {}", list.status()));
    }

    let json = list.json::<Value>().await.map_err(|e| e.to_string())?;
    let refs = json.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut results = Vec::new();
    for msg in refs {
        let Some(id) = msg.get("id").and_then(Value::as_str) else { continue; };

        let detail = client
            .get(format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=full", id))
            .bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
        if !detail.status().is_success() { continue; }

        let detail_json = detail.json::<Value>().await.map_err(|e| e.to_string())?;
        let headers = detail_json.get("payload").and_then(|p| p.get("headers")).and_then(Value::as_array).cloned().unwrap_or_default();

        let snippet = strip_confusable_chars(detail_json.get("snippet").and_then(Value::as_str).unwrap_or_default());
        let subject = strip_confusable_chars(&header_value(&headers, "Subject").unwrap_or_else(|| "(No Subject)".to_string()));
        let sender = strip_confusable_chars(&header_value(&headers, "From").unwrap_or_else(|| "Unknown Sender".to_string()));
        let to_recipients = strip_confusable_chars(&header_value(&headers, "To").unwrap_or_default());
        let cc_recipients = strip_confusable_chars(&header_value(&headers, "Cc").unwrap_or_default());
        let date = header_value(&headers, "Date").unwrap_or_default();
        let labels = detail_json.get("labelIds").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")).unwrap_or_default();
        let internal_ts = detail_json.get("internalDate").and_then(Value::as_str).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        let body_html = detail_json.get("payload").and_then(extract_body).unwrap_or_else(|| format!("<pre>{}</pre>", snippet));
        let mut attachments: Vec<AttachmentMeta> = Vec::new();
        if let Some(payload) = detail_json.get("payload") { collect_attachments(payload, &mut attachments); }
        let attachments_json = serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".to_string());

        results.push(Email {
            id: format!("{}:{}", account_id, id),
            account_id,
            draft_id: None,
            thread_id: detail_json.get("threadId").and_then(Value::as_str).unwrap_or_default().to_string(),
            subject, sender, to_recipients, cc_recipients, snippet, body_html, attachments_json,
            has_attachments: !attachments.is_empty(),
            date,
            is_read: !labels.split(',').any(|l| l == "UNREAD"),
            starred: labels.split(',').any(|l| l == "STARRED"),
            mailbox: mailbox_from_labels(&labels),
            labels,
            internal_ts,
            uid: None,
            message_id_header: header_value(&headers, "Message-ID"),
        });
    }

    Ok(results)
}

#[tauri::command]
pub async fn set_email_read_status(
    state: State<'_, Arc<DbState>>,
    email_id: String,
    is_read: bool,
) -> Result<(), String> {
    let account_id = get_active_id(&state).await;
    let (account, mailbox, uid) = {
        let conn = state.conn.lock().await;
        let acc = crate::db::get_account_by_id(&conn, account_id).ok().flatten()
            .ok_or_else(|| "Account not found".to_string())?;
        let (mb, u) = conn.query_row(
            "SELECT mailbox, uid FROM emails WHERE id=?1 AND account_id=?2",
            rusqlite::params![email_id, account_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
        ).map_err(|e| e.to_string())?;
        (acc, mb, u)
    };

    if account.provider == "imap" {
        if let Some(u) = uid {
            let action = if is_read { crate::imap_sync::ImapAction::MarkRead } else { crate::imap_sync::ImapAction::MarkUnread };
            let acc = account.clone();
            tokio::task::spawn_blocking(move || {
                crate::imap_sync::imap_action(&acc, &mailbox, u as u32, action)
            }).await.map_err(|e| e.to_string())??;
        }
    }

    let conn = state.conn.lock().await;
    conn.execute(
        "UPDATE emails SET is_read=?1 WHERE id=?2 AND account_id=?3",
        rusqlite::params![is_read as i32, email_id, account_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn toggle_starred(state: State<'_, Arc<DbState>>, email_id: String) -> Result<(), String> {
    let account_id = get_active_id(&state).await;
    let (account, mailbox, uid, current_starred) = {
        let conn = state.conn.lock().await;
        let acc = crate::db::get_account_by_id(&conn, account_id).ok().flatten()
            .ok_or_else(|| "Account not found".to_string())?;
        let (mb, u, s) = conn.query_row(
            "SELECT mailbox, uid, starred FROM emails WHERE id=?1 AND account_id=?2",
            rusqlite::params![email_id, account_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, i32>(2)? != 0))
        ).map_err(|e| e.to_string())?;
        (acc, mb, u, s)
    };

    if account.provider == "imap" {
        if let Some(u) = uid {
            let action = if current_starred { crate::imap_sync::ImapAction::Unstar } else { crate::imap_sync::ImapAction::Star };
            let acc = account.clone();
            tokio::task::spawn_blocking(move || {
                crate::imap_sync::imap_action(&acc, &mailbox, u as u32, action)
            }).await.map_err(|e| e.to_string())??;
        }
    }

    let conn = state.conn.lock().await;
    conn.execute(
        "UPDATE emails SET starred=CASE WHEN starred=1 THEN 0 ELSE 1 END WHERE id=?1 AND account_id=?2",
        rusqlite::params![email_id, account_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn archive_email(state: State<'_, Arc<DbState>>, email_id: String) -> Result<(), String> {
    let account_id = get_active_id(&state).await;
    let (account, mailbox, uid) = {
        let conn = state.conn.lock().await;
        let acc = crate::db::get_account_by_id(&conn, account_id).ok().flatten()
            .ok_or_else(|| "Account not found".to_string())?;
        let (mb, u) = conn.query_row(
            "SELECT mailbox, uid FROM emails WHERE id=?1 AND account_id=?2",
            rusqlite::params![email_id, account_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
        ).map_err(|e| e.to_string())?;
        (acc, mb, u)
    };

    if account.provider == "gmail" {
        let gmail_id = email_id.splitn(2, ':').nth(1).unwrap_or(&email_id).to_string();
        let token = ensure_token(&state).await?.access_token;
        let client = reqwest::Client::new();
        let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify", gmail_id);
        let res = client.post(url).bearer_auth(&token)
            .json(&json!({"removeLabelIds": ["INBOX"]}))
            .send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("Archive failed: {}", res.status()));
        }
    } else if account.provider == "imap" {
        if let Some(u) = uid {
            let acc = account.clone();
            tokio::task::spawn_blocking(move || {
                crate::imap_sync::imap_action(&acc, &mailbox, u as u32, crate::imap_sync::ImapAction::Archive)
            }).await.map_err(|e| e.to_string())??;
        }
    }

    let conn = state.conn.lock().await;
    conn.execute(
        "UPDATE emails SET mailbox='ARCHIVE' WHERE id=?1 AND account_id=?2",
        rusqlite::params![email_id, account_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn trash_email(state: State<'_, Arc<DbState>>, email_id: String) -> Result<(), String> {
    let account_id = get_active_id(&state).await;
    let (account, mailbox, uid) = {
        let conn = state.conn.lock().await;
        let acc = crate::db::get_account_by_id(&conn, account_id).ok().flatten()
            .ok_or_else(|| "Account not found".to_string())?;
        let (mb, u) = conn.query_row(
            "SELECT mailbox, uid FROM emails WHERE id=?1 AND account_id=?2",
            rusqlite::params![email_id, account_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
        ).map_err(|e| e.to_string())?;
        (acc, mb, u)
    };

    if account.provider == "gmail" {
        let gmail_id = email_id.splitn(2, ':').nth(1).unwrap_or(&email_id).to_string();
        let token = ensure_token(&state).await?.access_token;
        let client = reqwest::Client::new();
        let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/trash", gmail_id);
        let res = client.post(url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("Trash failed: {}", res.status()));
        }
    } else if account.provider == "imap" {
        if let Some(u) = uid {
            let acc = account.clone();
            tokio::task::spawn_blocking(move || {
                crate::imap_sync::imap_action(&acc, &mailbox, u as u32, crate::imap_sync::ImapAction::Trash)
            }).await.map_err(|e| e.to_string())??;
        }
    }

    let conn = state.conn.lock().await;
    conn.execute(
        "DELETE FROM emails WHERE id=?1 AND account_id=?2",
        rusqlite::params![email_id, account_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_mailbox_counts(state: State<'_, Arc<DbState>>) -> Result<MailboxCounts, String> {
    let account_id = get_active_id(&state).await;
    let conn = state.conn.lock().await;

    let count = |sql: &str| -> i64 {
        conn.query_row(sql, rusqlite::params![account_id], |r| r.get(0)).unwrap_or(0)
    };

    Ok(MailboxCounts {
        inbox_total: count("SELECT COUNT(*) FROM emails WHERE mailbox='INBOX' AND account_id=?1"),
        inbox_unread: count("SELECT COUNT(*) FROM emails WHERE mailbox='INBOX' AND is_read=0 AND account_id=?1"),
        starred_total: count("SELECT COUNT(*) FROM emails WHERE starred=1 AND account_id=?1"),
        sent_total: count("SELECT COUNT(*) FROM emails WHERE mailbox='SENT' AND account_id=?1"),
        drafts_total: count("SELECT COUNT(*) FROM emails WHERE mailbox='DRAFT' AND account_id=?1"),
        archive_total: count("SELECT COUNT(*) FROM emails WHERE mailbox='ARCHIVE' AND account_id=?1"),
    })
}

#[tauri::command]
pub async fn clear_local_data(state: State<'_, Arc<DbState>>) -> Result<(), String> {
    let account_id = get_active_id(&state).await;
    let conn = state.conn.lock().await;
    clear_account_emails(&conn, account_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ThreadSummary {
    pub thread_id: String,
    pub subject: String,
    pub participants: String,
    pub snippet: String,
    pub latest_ts: i64,
    pub latest_date: String,
    pub message_count: i64,
    pub unread_count: i64,
    pub is_read: bool,
    pub starred: bool,
    pub has_attachments: bool,
    pub labels: String,
}

#[tauri::command]
pub async fn get_inbox_threads(state: State<'_, Arc<DbState>>) -> Result<Vec<ThreadSummary>, String> {
    let account_id = get_active_id(&state).await;
    let conn = state.conn.lock().await;

    let sql = "
        WITH latest_msg AS (
            SELECT thread_id, id, subject, snippet, date, labels,
                   ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY internal_ts DESC) as rn
            FROM emails
            WHERE mailbox = 'INBOX' AND account_id = ?1
        )
        SELECT
            e.thread_id,
            l.subject,
            l.snippet,
            l.date,
            l.labels,
            COUNT(e.id) AS message_count,
            SUM(CASE WHEN e.is_read=0 THEN 1 ELSE 0 END) AS unread_count,
            MAX(e.internal_ts) AS latest_ts,
            MAX(e.starred) AS any_starred,
            MAX(e.has_attachments) AS any_attachments,
            GROUP_CONCAT(DISTINCT e.sender, '|||') AS all_senders
        FROM emails e
        JOIN latest_msg l ON e.thread_id = l.thread_id AND l.rn = 1
        WHERE e.mailbox='INBOX' AND e.account_id=?1
        GROUP BY e.thread_id
        ORDER BY latest_ts DESC
        LIMIT 500
    ";

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let threads = stmt.query_map(rusqlite::params![account_id], |row| {
        let unread_count: i64 = row.get(6)?;
        Ok(ThreadSummary {
            thread_id: row.get(0)?,
            subject: row.get(1)?,
            snippet: row.get(2)?,
            latest_date: row.get(3)?,
            labels: row.get(4)?,
            message_count: row.get(5)?,
            unread_count,
            latest_ts: row.get(7)?,
            starred: row.get::<_, i64>(8)? != 0,
            has_attachments: row.get::<_, i64>(9)? != 0,
            is_read: unread_count == 0,
            participants: row.get(10).unwrap_or_default(),
        })
    }).map_err(|e| e.to_string())?
    .filter_map(Result::ok).collect();

    Ok(threads)
}

#[tauri::command]
pub async fn get_thread_messages(
    state: State<'_, Arc<DbState>>,
    thread_id: String,
) -> Result<Vec<Email>, String> {
    let account_id = get_active_id(&state).await;
    let conn = state.conn.lock().await;

    let mut stmt = conn.prepare(
        "SELECT id,account_id,draft_id,thread_id,subject,sender,to_recipients,cc_recipients,
                snippet,body_html,attachments_json,has_attachments,date,is_read,starred,mailbox,labels,internal_ts,uid,message_id_header
         FROM emails WHERE thread_id=?1 AND account_id=?2 ORDER BY internal_ts ASC, rowid ASC"
    ).map_err(|e| e.to_string())?;

    let emails = stmt.query_map(rusqlite::params![thread_id, account_id], map_email_row)
        .map_err(|e| e.to_string())?.filter_map(Result::ok).collect();
    Ok(emails)
}

#[tauri::command]
pub async fn remove_label(
    state: State<'_, Arc<DbState>>,
    email_id: String,
    label: String,
) -> Result<(), String> {
    let account_id = get_active_id(&state).await;

    let is_gmail = {
        let conn = state.conn.lock().await;
        crate::db::get_account_by_id(&conn, account_id)
            .ok().flatten()
            .map(|a| a.provider == "gmail")
            .unwrap_or(false)
    };

    if is_gmail {
        let gmail_id = email_id.splitn(2, ':').nth(1).unwrap_or(&email_id).to_string();
        let token = ensure_token(&state).await?.access_token;
        let client = reqwest::Client::new();
        let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}/modify", gmail_id);
        let res = client.post(url).bearer_auth(&token)
            .json(&json!({"removeLabelIds": [label]}))
            .send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("Remove label failed: {}", res.status()));
        }
    }

    let conn = state.conn.lock().await;
    let mut current_labels: String = conn.query_row(
        "SELECT labels FROM emails WHERE id=?1 AND account_id=?2",
        rusqlite::params![email_id, account_id],
        |r| r.get(0)
    ).unwrap_or_default();

    let next_labels = current_labels.split(',')
        .filter(|l| l.trim() != label.trim())
        .collect::<Vec<_>>()
        .join(",");

    conn.execute(
        "UPDATE emails SET labels=?1 WHERE id=?2 AND account_id=?3",
        rusqlite::params![next_labels, email_id, account_id],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn mark_thread_read(state: State<'_, Arc<DbState>>, thread_id: String) -> Result<(), String> {
    let account_id = get_active_id(&state).await;
    let conn = state.conn.lock().await;
    conn.execute(
        "UPDATE emails SET is_read=1 WHERE thread_id=?1 AND account_id=?2",
        rusqlite::params![thread_id, account_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
