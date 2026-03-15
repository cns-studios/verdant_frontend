use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Email {
    pub id: String,
    pub thread_id: String,
    pub subject: String,
    pub sender: String,
    pub snippet: String,
    pub body_html: String,
    pub date: String,
    pub is_read: bool,
    pub starred: bool,
    pub mailbox: String,
    pub labels: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_epoch: Option<i64>,
}

pub fn init_db(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS emails (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            sender TEXT NOT NULL,
            snippet TEXT NOT NULL DEFAULT '',
            body_html TEXT NOT NULL,
            date TEXT NOT NULL,
            is_read INTEGER NOT NULL,
            starred INTEGER NOT NULL DEFAULT 0,
            mailbox TEXT NOT NULL DEFAULT 'INBOX',
            labels TEXT NOT NULL DEFAULT ''
        )",
        [],
    )?;

    // Lightweight migration for existing local DBs created before snippet existed.
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN snippet TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN starred INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN mailbox TEXT NOT NULL DEFAULT 'INBOX'", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN labels TEXT NOT NULL DEFAULT ''", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS oauth_tokens (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            expires_at_epoch INTEGER
        )",
        [],
    )?;

    // Cleanup for legacy mock data inserted by earlier prototype builds.
    let _ = conn.execute(
        "DELETE FROM emails
         WHERE id = '1'
           AND thread_id = 't1'
           AND sender = 'foo@example.com'",
        [],
    );

    let _ = conn.execute(
        "DELETE FROM emails
         WHERE subject = 'Welcome to Verdant'
           AND sender = 'foo@example.com'",
        [],
    );

    Ok(())
}

pub fn clear_tokens(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM oauth_tokens", [])?;
    Ok(())
}

pub fn clear_emails(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM emails", [])?;
    Ok(())
}

pub fn upsert_token(conn: &Connection, token: &StoredToken) -> Result<()> {
    conn.execute(
        "INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at_epoch)
         VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id)
         DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
            expires_at_epoch = excluded.expires_at_epoch",
        (
            &token.access_token,
            &token.refresh_token,
            &token.expires_at_epoch,
        ),
    )?;
    Ok(())
}

pub fn get_token(conn: &Connection) -> Result<Option<StoredToken>> {
    let mut stmt = conn.prepare(
        "SELECT access_token, refresh_token, expires_at_epoch
         FROM oauth_tokens
         WHERE id = 1",
    )?;

    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(StoredToken {
            access_token: row.get(0)?,
            refresh_token: row.get(1)?,
            expires_at_epoch: row.get(2)?,
        }));
    }

    Ok(None)
}
