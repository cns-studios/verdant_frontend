use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone)]
pub struct AttachmentMeta {
    pub filename: String,
    pub mime_type: String,
    pub attachment_id: String,
    pub size: i64,
}

pub fn decode_gmail_base64(data: &str) -> Option<String> {
    URL_SAFE_NO_PAD
        .decode(data.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

pub fn header_value(headers: &[Value], name: &str) -> Option<String> {
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

pub fn strip_confusable_chars(input: &str) -> String {
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

fn decode_part(payload: &Value) -> Option<String> {
    let data = payload
        .get("body")
        .and_then(|b| b.get("data"))
        .and_then(Value::as_str)?;

    use base64::engine::general_purpose::{STANDARD, URL_SAFE};

    let bytes = URL_SAFE_NO_PAD
        .decode(data.as_bytes())
        .or_else(|_| URL_SAFE.decode(data.as_bytes()))
        .or_else(|_| STANDARD.decode(data.as_bytes()))
        .ok()?;

    let decoded = String::from_utf8_lossy(&bytes).into_owned();
    if decoded.is_empty() {
        return None;
    }
    Some(strip_confusable_chars(&decoded))
}

pub fn extract_body(payload: &Value) -> Option<String> {
    let mime = payload
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    if mime == "text/html" {
        if let Some(text) = decode_part(payload) {
            return Some(text);
        }
    }
    if mime == "text/plain" {
        if let Some(text) = decode_part(payload) {
            return Some(format!("<pre>{}</pre>", text));
        }
    }

    let parts = match payload.get("parts").and_then(Value::as_array) {
        Some(p) => p,
        None => return None,
    };

    if mime == "multipart/alternative" {
        let mut html_result: Option<String> = None;
        let mut plain_result: Option<String> = None;

        for part in parts {
            let part_mime = part
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();


            if part_mime == "text/html" && html_result.is_none() {
                let decoded = decode_part(part);
                html_result = decoded;
            } else if part_mime == "text/plain" && plain_result.is_none() {
                if let Some(text) = decode_part(part) {
                    plain_result = Some(format!("<pre>{}</pre>", text));
                }
            } else if part_mime.starts_with("multipart/") {
                if let Some(nested) = extract_body(part) {
                    if html_result.is_none() {
                        html_result = Some(nested);
                    }
                }
            }
        }

        return html_result.or(plain_result);
    }

    let mut plain_fallback: Option<String> = None;
    for part in parts {
        if let Some(found) = extract_body(part) {
            if !found.trim_start().starts_with("<pre>") {
                return Some(found);
            }
            if plain_fallback.is_none() {
                plain_fallback = Some(found);
            }
        }
    }
    return plain_fallback;
}

pub fn collect_attachments(payload: &Value, out: &mut Vec<AttachmentMeta>) {
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

pub fn mailbox_label(mailbox: &str) -> Option<&'static str> {
    match mailbox {
        "INBOX" => Some("INBOX"),
        "SENT" => Some("SENT"),
        "DRAFT" => Some("DRAFT"),
        "TRASH" => Some("TRASH"),
        _ => None,
    }
}

pub fn mailbox_from_labels(labels: &str) -> String {
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
