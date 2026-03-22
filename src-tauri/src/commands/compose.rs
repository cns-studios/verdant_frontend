use std::sync::Arc;
use serde_json::{json, Value};
use tauri::State;

use crate::commands::mail::sync_mailbox_internal_for;
use crate::db::get_account_by_id;
use crate::mime::{build_raw_mime_message, EmailAttachment};
use crate::smtp_send::{send_imap_email, SmtpAttachment};
use crate::state::{ensure_token, DbState, get_active_id};

#[derive(serde::Serialize)]
pub struct DraftSaveResult {
    pub draft_id: String,
}

#[tauri::command]
pub async fn send_email(
    state: State<'_, Arc<DbState>>,
    to: String,
    cc: String,
    subject: String,
    body: String,
    mode: String,
    body_html: Option<String>,
    attachments: Vec<EmailAttachment>,
    in_reply_to: Option<String>,
    references: Option<String>,
) -> Result<(), String> {
    let account_id = get_active_id(&state).await;
    let account = {
        let conn = state.conn.lock().await;
        get_account_by_id(&conn, account_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No active account".to_string())?
    };

    if account.provider == "imap" {
        let smtp_attachments: Vec<SmtpAttachment> = attachments.into_iter().map(|a| SmtpAttachment {
            filename: a.filename,
            content_type: a.content_type,
            data_base64: a.data_base64,
        }).collect();

        let html = if mode.eq_ignore_ascii_case("html") || mode.eq_ignore_ascii_case("markdown") {
            body_html.or_else(|| Some(crate::mime::markdown_to_html(&body)))
        } else {
            None
        };

        let account_clone = account.clone();
        let to_c = to.clone();
        let cc_c = cc.clone();
        let subject_c = subject.clone();
        let body_c = body.clone();
        let html_c = html.clone();
        let attachments_c = smtp_attachments.clone();
        let in_reply_to_c = in_reply_to.clone();
        let references_c = references.clone();

        tokio::task::spawn_blocking(move || {
            send_imap_email(&account_clone, &to_c, &cc_c, &subject_c, &body_c,
                html_c.as_deref(), attachments_c, in_reply_to_c, references_c)?;
            crate::imap_sync::append_to_sent(&account_clone, &to_c, &cc_c, &subject_c, &body_c, html_c.as_deref())
        }).await.map_err(|e| e.to_string())??;

        // Kick off background SENT sync for IMAP — fire and forget, don't surface errors
        let state_arc = (*state).clone();
        tokio::spawn(async move {
            let _ = sync_mailbox_internal_for(&state_arc, account_id, "SENT").await;
        });

        return Ok(());
    }

    // Gmail path
    let token = ensure_token(&state).await?.access_token;
    let encoded = build_raw_mime_message(to, cc, subject, body, mode, body_html, attachments)?;
    let client = reqwest::Client::new();
    let res = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
        .bearer_auth(&token)
        .json(&json!({ "raw": encoded }))
        .send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Send error: {}", res.status()));
    }

    Ok(())
}

#[tauri::command]
pub async fn save_draft(
    state: State<'_, Arc<DbState>>,
    to: String,
    cc: String,
    subject: String,
    body: String,
    mode: String,
    body_html: Option<String>,
    attachments: Vec<EmailAttachment>,
    draft_id: Option<String>,
) -> Result<DraftSaveResult, String> {
    let account_id = get_active_id(&state).await;
    let account = {
        let conn = state.conn.lock().await;
        get_account_by_id(&conn, account_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No active account".to_string())?
    };

    if account.provider == "imap" {
        let conn = state.conn.lock().await;
        let draft_id = draft_id.clone()
            .filter(|d| !d.trim().is_empty())
            .unwrap_or_else(|| format!("local-draft-{}", chrono::Utc::now().timestamp_millis()));
        
        let composite_id = format!("{}:draft:{}", account_id, draft_id);
        let now = chrono::Utc::now();
        let date_str = now.format("%a, %d %b %Y %H:%M:%S +0000").to_string();
        let internal_ts = now.timestamp_millis();

        conn.execute(
            "INSERT INTO emails (id, account_id, draft_id, thread_id, subject, sender, to_recipients, cc_recipients,
                                snippet, body_html, attachments_json, has_attachments, date, is_read, starred,
                                mailbox, labels, internal_ts)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'[]',0,?11,1,0,'DRAFT','DRAFT',?12)
            ON CONFLICT(id, account_id) DO UPDATE SET
                subject = excluded.subject,
                to_recipients = excluded.to_recipients,
                cc_recipients = excluded.cc_recipients,
                body_html = excluded.body_html,
                snippet = excluded.snippet,
                date = excluded.date,
                internal_ts = excluded.internal_ts",
            rusqlite::params![
                composite_id, account_id, draft_id, draft_id,
                subject, body.chars().take(60).collect::<String>(),
                to, cc,
                body.chars().take(120).collect::<String>(),
                body_html.as_deref().unwrap_or(&body),
                date_str, internal_ts
            ],
        ).map_err(|e| e.to_string())?;

        return Ok(DraftSaveResult { draft_id });
    }

    // Gmail path
    let token = ensure_token(&state).await?.access_token;
    let encoded = build_raw_mime_message(to, cc, subject, body, mode, body_html, attachments)?;
    let payload = json!({ "message": { "raw": encoded } });
    let client = reqwest::Client::new();

    let res = if let Some(existing_id) = draft_id.clone().filter(|d| !d.trim().is_empty()) {
        client.put(format!("https://gmail.googleapis.com/gmail/v1/users/me/drafts/{}", existing_id))
            .bearer_auth(&token).json(&payload).send().await.map_err(|e| e.to_string())?
    } else {
        client.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts")
            .bearer_auth(&token).json(&payload).send().await.map_err(|e| e.to_string())?
    };

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Draft save failed: {} {}", status, body));
    }

    let data = res.json::<Value>().await.map_err(|e| e.to_string())?;
    let saved_draft_id = data.get("id").and_then(Value::as_str).map(str::to_string)
        .ok_or_else(|| "Draft save returned no id".to_string())?;

    sync_mailbox_internal_for(&state, account_id, "DRAFT").await?;

    Ok(DraftSaveResult { draft_id: saved_draft_id })
}

#[tauri::command]
pub async fn send_existing_draft(
    state: State<'_, Arc<DbState>>,
    draft_id: String,
) -> Result<(), String> {
    let account_id = get_active_id(&state).await;
    let is_imap = {
        let conn = state.conn.lock().await;
        crate::db::get_account_by_id(&conn, account_id)
            .ok().flatten()
            .map(|a| a.provider == "imap")
            .unwrap_or(false)
    };

    if is_imap {
        let conn = state.conn.lock().await;
        let composite = format!("{}:draft:{}", account_id, draft_id.trim());
        conn.execute(
            "DELETE FROM emails WHERE (id=?1 OR draft_id=?2) AND account_id=?3 AND mailbox='DRAFT'",
            rusqlite::params![composite, draft_id.trim(), account_id],
        ).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let token = ensure_token(&state).await?.access_token;
    let client = reqwest::Client::new();
    let draft_id_clean = draft_id.trim().to_string();

    let res = client
        .post("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send")
        .bearer_auth(&token)
        .json(&json!({ "id": draft_id_clean }))
        .send().await.map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Draft send failed: {} {}", status, body));
    }

    let sent_msg = res.json::<Value>().await.ok();
    let sent_message_id = sent_msg.as_ref()
        .and_then(|v| v.get("id")).and_then(Value::as_str).map(str::to_string);

    {
        let conn = state.conn.lock().await;
        if let Some(message_id) = sent_message_id {
            let composite = format!("{}:{}", account_id, message_id);
            let _ = conn.execute(
                "DELETE FROM emails WHERE mailbox='DRAFT' AND account_id=?1 AND (draft_id=?2 OR id=?3)",
                rusqlite::params![account_id, draft_id_clean, composite],
            );
        } else {
            let _ = conn.execute(
                "DELETE FROM emails WHERE mailbox='DRAFT' AND account_id=?1 AND draft_id=?2",
                rusqlite::params![account_id, draft_id_clean],
            );
        }
    }

    let _ = sync_mailbox_internal_for(&state, account_id, "DRAFT").await;
    let _ = sync_mailbox_internal_for(&state, account_id, "SENT").await;
    Ok(())
}
