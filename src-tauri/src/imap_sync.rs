use crate::crypto::decrypt_password;
use crate::db::{Account, Email};
use mailparse::{parse_mail, MailHeaderMap};
use native_tls::TlsConnector;

pub struct ImapCredentials {
    pub imap_host: String,
    pub imap_port: u16,
    pub username: String,
    pub password: String,
}

impl ImapCredentials {
    pub fn from_account(account: &Account) -> Result<Self, String> {
        let imap_host = account.imap_host.clone()
            .ok_or_else(|| "Missing IMAP host".to_string())?;
        let imap_port = account.imap_port
            .ok_or_else(|| "Missing IMAP port".to_string())? as u16;
        let username = account.username.clone()
            .ok_or_else(|| "Missing IMAP username".to_string())?;
        let encrypted_password = account.encrypted_password.clone()
            .ok_or_else(|| "Missing encrypted password".to_string())?;
        let password = decrypt_password(&encrypted_password)?;
        Ok(ImapCredentials { imap_host, imap_port, username, password })
    }
}

type TlsSession = imap::Session<native_tls::TlsStream<std::net::TcpStream>>;

fn connect(creds: &ImapCredentials) -> Result<TlsSession, String> {
    let tls = TlsConnector::builder()
        .build()
        .map_err(|e| format!("TLS build error: {}", e))?;

    let client = imap::connect(
        (creds.imap_host.as_str(), creds.imap_port),
        &creds.imap_host,
        &tls,
    ).map_err(|e| format!("IMAP connect error: {}", e))?;

    let session = client
        .login(&creds.username, &creds.password)
        .map_err(|(e, _)| format!("IMAP login error: {}", e))?;

    Ok(session)
}

fn decode_imap_utf7(input: &str) -> String {
    input
        .replace("&APw-", "ü")
        .replace("&APY-", "ö")
        .replace("&AOQ-", "ä")
        .replace("&AOU-", "Ö")
        .replace("&AMD-", "Ä")
        .replace("&AUQ-", "Ü")
        .replace("&AQ8-", "ß")
}

fn imap_folder_for_mailbox(mailbox: &str, folders: &[String]) -> Option<String> {
    let target = mailbox.to_uppercase();

    for folder in folders {
        let decoded = decode_imap_utf7(folder);
        if decoded.to_uppercase() == target {
            return Some(folder.clone());
        }
    }

    let candidates: &[&str] = match target.as_str() {
        "SENT" => &[
            "SENT", "SENT ITEMS", "SENT MESSAGES",
            "GESENDET", "GESENDETE ELEMENTE",
            "[GMAIL]/SENT MAIL", "INBOX.SENT",
        ],
        "DRAFT" => &[
            "DRAFTS", "DRAFT", "ENTW\u{00DC}RFE",
            "[GMAIL]/DRAFTS", "INBOX.DRAFTS",
        ],
        "ARCHIVE" => &[
            "ARCHIVE", "ALL MAIL", "ARCHIV",
            "[GMAIL]/ALL MAIL", "INBOX.ARCHIVE",
        ],
        _ => return None,
    };

    for candidate in candidates {
        for folder in folders {
            let decoded = decode_imap_utf7(folder);
            if decoded.to_uppercase() == *candidate {
                return Some(folder.clone());
            }
        }
    }

    for folder in folders {
        let decoded = decode_imap_utf7(folder);
        if decoded.to_uppercase().contains(&target) {
            return Some(folder.clone());
        }
    }

    None
}

fn parse_body(parsed: &mailparse::ParsedMail) -> String {
    if parsed.subparts.is_empty() {
        let ct = parsed.ctype.mimetype.to_lowercase();
        if ct == "text/html" {
            return parsed.get_body().unwrap_or_default();
        }
        if ct == "text/plain" {
            return format!("<pre>{}</pre>", html_escape(&parsed.get_body().unwrap_or_default()));
        }
        return String::new();
    }
    let mut html_result = None;
    let mut plain_result = None;
    for part in &parsed.subparts {
        let ct = part.ctype.mimetype.to_lowercase();
        if ct == "text/html" && html_result.is_none() {
            html_result = part.get_body().ok();
        } else if ct == "text/plain" && plain_result.is_none() {
            if let Ok(body) = part.get_body() {
                plain_result = Some(format!("<pre>{}</pre>", html_escape(&body)));
            }
        } else if ct.starts_with("multipart/") {
            let nested = parse_body(part);
            if !nested.is_empty() && html_result.is_none() {
                html_result = Some(nested);
            }
        }
    }
    html_result.or(plain_result).unwrap_or_default()
}

fn html_escape(input: &str) -> String {
    input.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn collect_imap_attachments(parsed: &mailparse::ParsedMail, uid: &str) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for (i, part) in parsed.subparts.iter().enumerate() {
        let ct = part.ctype.mimetype.to_lowercase();
        let disp = part.get_content_disposition();
        let filename = disp.params.get("filename")
            .or_else(|| part.ctype.params.get("name"))
            .cloned().unwrap_or_default();

        if !filename.is_empty() && ct != "text/plain" && ct != "text/html" {
            let size = part.get_body_raw().map(|b| b.len()).unwrap_or(0);
            out.push(serde_json::json!({
                "filename": filename,
                "mime_type": ct,
                "attachment_id": format!("imap-{}-{}", uid, i),
                "size": size,
            }));
        } else if !part.subparts.is_empty() {
            
            out.extend(collect_imap_attachments(part, uid));
        }
    }
    out
}

fn rfc2822_to_epoch(date_str: &str) -> i64 {
    use chrono::DateTime;
    DateTime::parse_from_rfc2822(date_str).map(|dt| dt.timestamp()).unwrap_or(0)
}

pub fn sync_imap_mailbox(
    account: &Account,
    mailbox_label: &str,
    max_messages: u32,
) -> Result<Vec<Email>, String> {
    let creds = ImapCredentials::from_account(account)?;
    let mut session = connect(&creds)?;

    let folders: Vec<String> = session
        .list(None, Some("*"))
        .map_err(|e| format!("IMAP LIST error: {}", e))?
        .iter().map(|n| n.name().to_string()).collect();


        let folder = match imap_folder_for_mailbox(mailbox_label, &folders) {
            Some(f) => {
                f
            },
            None => { 
                let _ = session.logout(); return Ok(vec![]); 
            }
        };


    let mailbox_info = session.select(&folder)
        .map_err(|e| format!("IMAP SELECT error: {}", e))?;

    let total = mailbox_info.exists as u32;
    if total == 0 { let _ = session.logout(); return Ok(vec![]); }

    let start = if total > max_messages { total - max_messages + 1 } else { 1 };
    let messages = session
        .fetch(&format!("{}:{}", start, total), "(RFC822 FLAGS UID)")
        .map_err(|e| format!("IMAP FETCH error: {}", e))?;

    let mut emails = Vec::new();
    let mut seen_uids = std::collections::HashSet::new();

    for msg in messages.iter() {
        let uid = msg.uid.map(|u| u.to_string())
            .unwrap_or_else(|| msg.message.to_string());

        let body_bytes = msg.body().unwrap_or(b"");
        let min_size = if mailbox_label == "INBOX" { 500 } else { 50 };
        if body_bytes.len() < min_size {
            continue;
        }

        if !seen_uids.insert(uid.clone()) {
            continue;
        }

        let parsed = match parse_mail(body_bytes) { Ok(p) => p, Err(_) => continue };

        let headers = parsed.get_headers();
        let subject        = headers.get_first_value("Subject").unwrap_or_else(|| "(No Subject)".to_string());
        let sender         = headers.get_first_value("From").unwrap_or_else(|| "Unknown Sender".to_string());
        let to_recipients  = headers.get_first_value("To").unwrap_or_default();
        let cc_recipients  = headers.get_first_value("Cc").unwrap_or_default();
        let date           = headers.get_first_value("Date").unwrap_or_default();
        let message_id = headers.get_first_value("Message-ID")
            .unwrap_or_else(|| format!("imap-{}-{}-{}", account.id, mailbox_label, uid));
        let thread_id      = headers.get_first_value("In-Reply-To")
            .unwrap_or_else(|| message_id.clone());

        let is_read = msg.flags().iter().any(|f| matches!(f, imap::types::Flag::Seen));
        let starred = msg.flags().iter().any(|f| matches!(f, imap::types::Flag::Flagged));
        let body_html = parse_body(&parsed);
        let snippet: String = parsed.get_body().unwrap_or_default()
            .chars().take(180).collect::<String>().replace('\n', " ");
        let attachments = collect_imap_attachments(&parsed, &uid);
        let has_attachments = !attachments.is_empty();
        let attachments_json = serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".to_string());
        let internal_ts = rfc2822_to_epoch(&date);
        let id = format!("{}:{}", account.id, message_id.trim_matches(|c: char| c == '<' || c == '>'));

        emails.push(Email {
            id,
            account_id: account.id,
            draft_id: None,
            thread_id: thread_id.trim_matches(|c: char| c == '<' || c == '>').to_string(),
            subject: strip_noise(&subject),
            sender: strip_noise(&sender),
            to_recipients: strip_noise(&to_recipients),
            cc_recipients: strip_noise(&cc_recipients),
            snippet: strip_noise(&snippet),
            body_html: if body_html.is_empty() { format!("<pre>{}</pre>", html_escape(&snippet)) } else { body_html },
            attachments_json,
            has_attachments,
            date,
            is_read,
            starred,
            mailbox: mailbox_label.to_string(),
            labels: mailbox_label.to_string(),
            internal_ts,
            uid: msg.uid.map(|u| u as i64),
            message_id_header: Some(message_id),
        });
    }

    let _ = session.logout();
    emails.sort_by(|a, b| b.internal_ts.cmp(&a.internal_ts));
    Ok(emails)
}

fn strip_noise(input: &str) -> String {
    input.chars().filter(|c| !matches!(*c,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{180E}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2069}' | '\u{FEFF}'
    )).collect()
}

pub fn test_imap_connection(
    imap_host: &str,
    imap_port: u16,
    username: &str,
    password: &str,
) -> Result<String, String> {
    let tls = TlsConnector::builder()
        .build()
        .map_err(|e| format!("TLS error: {}", e))?;

    let client = imap::connect((imap_host, imap_port), imap_host, &tls)
        .map_err(|e| format!("Connection failed: {}", e))?;

    let mut session = client
        .login(username, password)
        .map_err(|(e, _)| format!("Login failed: {}", e))?;

    let _ = session.logout();
    Ok(username.to_string())
}

pub fn append_to_sent(
    account: &crate::db::Account,
    to: &str,
    cc: &str,
    subject: &str,
    body_plain: &str,
    body_html: Option<&str>,
) -> Result<(), String> {
    let creds = ImapCredentials::from_account(account)?;
    let mut session = connect(&creds)?;

    let folders: Vec<String> = session
        .list(None, Some("*"))
        .map_err(|e| format!("IMAP LIST error: {}", e))?
        .iter().map(|n| n.name().to_string()).collect();

    let sent_folder = imap_folder_for_mailbox("SENT", &folders)
        .ok_or_else(|| "Could not find Sent folder".to_string())?;

    
    let date = chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S +0000").to_string();
    let body = if let Some(html) = body_html {
        format!(
            "To: {}\r\nCc: {}\r\nSubject: {}\r\nDate: {}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"verdant-alt\"\r\n\r\n--verdant-alt\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{}\r\n--verdant-alt\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n{}\r\n--verdant-alt--\r\n",
            to, cc, subject, date, body_plain, html
        )
    } else {
        format!(
            "To: {}\r\nCc: {}\r\nSubject: {}\r\nDate: {}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{}\r\n",
            to, cc, subject, date, body_plain
        )
    };

    let flags = imap::types::Flag::Seen;
    session
        .append_with_flags(&sent_folder, body.as_bytes(), &[flags])
        .map_err(|e| format!("IMAP APPEND error: {}", e))?;

    let _ = session.logout();
    Ok(())
}

pub enum ImapAction {
    MarkRead,
    MarkUnread,
    Star,
    Unstar,
    Archive,
    Trash,
}

pub fn imap_action(
    account: &Account,
    mailbox: &str,
    uid: u32,
    action: ImapAction,
) -> Result<(), String> {
    let creds = ImapCredentials::from_account(account)?;
    let mut session = connect(&creds)?;

    let folders: Vec<String> = session
        .list(None, Some("*"))
        .map_err(|e| format!("IMAP LIST error: {}", e))?
        .iter().map(|n| n.name().to_string()).collect();

    let folder = imap_folder_for_mailbox(mailbox, &folders)
        .ok_or_else(|| format!("Folder for mailbox {} not found", mailbox))?;

    session.select(&folder).map_err(|e| format!("IMAP SELECT error: {}", e))?;

    match action {
        ImapAction::MarkRead => {
            session.uid_store(format!("{}", uid), "+FLAGS (\\Seen)")
                .map_err(|e| format!("IMAP STORE error: {}", e))?;
        }
        ImapAction::MarkUnread => {
            session.uid_store(format!("{}", uid), "-FLAGS (\\Seen)")
                .map_err(|e| format!("IMAP STORE error: {}", e))?;
        }
        ImapAction::Star => {
            session.uid_store(format!("{}", uid), "+FLAGS (\\Flagged)")
                .map_err(|e| format!("IMAP STORE error: {}", e))?;
        }
        ImapAction::Unstar => {
            session.uid_store(format!("{}", uid), "-FLAGS (\\Flagged)")
                .map_err(|e| format!("IMAP STORE error: {}", e))?;
        }
        ImapAction::Archive | ImapAction::Trash => {
            let target_mailbox = match action {
                ImapAction::Archive => "ARCHIVE",
                _ => "TRASH",
            };
            let target_folder = imap_folder_for_mailbox(target_mailbox, &folders)
                .ok_or_else(|| format!("Target folder for {} not found", target_mailbox))?;

            session.uid_copy(format!("{}", uid), &target_folder)
                .map_err(|e| format!("IMAP COPY error: {}", e))?;
            session.uid_store(format!("{}", uid), "+FLAGS (\\Deleted)")
                .map_err(|e| format!("IMAP STORE error: {}", e))?;
            session.expunge().map_err(|e| format!("IMAP EXPUNGE error: {}", e))?;
        }
    }

    let _ = session.logout();
    Ok(())
}