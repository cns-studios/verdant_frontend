use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub provider: String,
    pub display_name: Option<String>,
    pub is_active: bool,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at_epoch: Option<i64>,
    pub imap_host: Option<String>,
    pub imap_port: Option<i64>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<i64>,
    pub username: Option<String>,
    pub encrypted_password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AccountPublic {
    pub id: i64,
    pub email: String,
    pub provider: String,
    pub display_name: Option<String>,
    pub is_active: bool,
}

impl From<Account> for AccountPublic {
    fn from(a: Account) -> Self {
        AccountPublic {
            id: a.id,
            email: a.email,
            provider: a.provider,
            display_name: a.display_name,
            is_active: a.is_active,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Email {
    pub id: String,
    pub account_id: i64,
    pub draft_id: Option<String>,
    pub thread_id: String,
    pub subject: String,
    pub sender: String,
    pub to_recipients: String,
    pub cc_recipients: String,
    pub snippet: String,
    pub body_html: String,
    pub attachments_json: String,
    pub has_attachments: bool,
    pub date: String,
    pub is_read: bool,
    pub starred: bool,
    pub mailbox: String,
    pub labels: String,
    pub internal_ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at_epoch: Option<i64>,
}

pub fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL DEFAULT 'gmail',
            display_name TEXT,
            is_active INTEGER NOT NULL DEFAULT 0,
            access_token TEXT,
            refresh_token TEXT,
            expires_at_epoch INTEGER,
            imap_host TEXT,
            imap_port INTEGER,
            smtp_host TEXT,
            smtp_port INTEGER,
            username TEXT,
            encrypted_password TEXT
        );
    ")?;

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS emails (
            id TEXT NOT NULL,
            account_id INTEGER NOT NULL DEFAULT 1,
            draft_id TEXT,
            thread_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            sender TEXT NOT NULL,
            to_recipients TEXT NOT NULL DEFAULT '',
            cc_recipients TEXT NOT NULL DEFAULT '',
            snippet TEXT NOT NULL DEFAULT '',
            body_html TEXT NOT NULL,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            has_attachments INTEGER NOT NULL DEFAULT 0,
            date TEXT NOT NULL,
            is_read INTEGER NOT NULL,
            starred INTEGER NOT NULL DEFAULT 0,
            mailbox TEXT NOT NULL DEFAULT 'INBOX',
            labels TEXT NOT NULL DEFAULT '',
            internal_ts INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (id, account_id)
        );
    ")?;

    // Legacy oauth_tokens migration — runs once, then the table is left in place
    // but the placeholder account is cleaned up immediately after.
    let legacy_exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='oauth_tokens'",
        [],
        |r| r.get::<_, i64>(0),
    ).unwrap_or(0) > 0;

    if legacy_exists {
        let migrated = conn.query_row(
            "SELECT access_token, refresh_token, expires_at_epoch FROM oauth_tokens WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        );

        if let Ok((access_token, refresh_token, expires)) = migrated {
            conn.execute(
                "INSERT OR IGNORE INTO accounts (email, provider, is_active, access_token, refresh_token, expires_at_epoch)
                 VALUES ('migrated@gmail.com', 'gmail', 1, ?1, ?2, ?3)",
                params![access_token, refresh_token, expires],
            )?;
        }

        let _ = conn.execute("ALTER TABLE emails ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1", []);
    }

    // Always clean up the placeholder migration account if no real emails are
    // associated with it — it only existed as a token carrier and is no longer needed.
    let _ = conn.execute(
        "DELETE FROM accounts WHERE email = 'migrated@gmail.com' AND NOT EXISTS (
            SELECT 1 FROM emails WHERE account_id = accounts.id
        )",
        [],
    );

    // Idempotent column additions (safe to fail if column already exists)
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN snippet TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN to_recipients TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN cc_recipients TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN starred INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN mailbox TEXT NOT NULL DEFAULT 'INBOX'", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN labels TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN internal_ts INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN draft_id TEXT", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'", []);
    let _ = conn.execute("ALTER TABLE emails ADD COLUMN has_attachments INTEGER NOT NULL DEFAULT 0", []);

    // Clean up seed/test data
    let _ = conn.execute(
        "DELETE FROM emails WHERE subject = 'Welcome to Verdant' AND sender = 'foo@example.com'",
        [],
    );

    Ok(())
}



pub fn get_all_accounts(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn.prepare(
        "SELECT id, email, provider, display_name, is_active,
                access_token, refresh_token, expires_at_epoch,
                imap_host, imap_port, smtp_host, smtp_port, username, encrypted_password
         FROM accounts ORDER BY id ASC"
    )?;
    let accounts = stmt.query_map([], map_account_row)?
        .filter_map(Result::ok)
        .collect();
    Ok(accounts)
}

pub fn get_active_account(conn: &Connection) -> Result<Option<Account>> {
    let mut stmt = conn.prepare(
        "SELECT id, email, provider, display_name, is_active,
                access_token, refresh_token, expires_at_epoch,
                imap_host, imap_port, smtp_host, smtp_port, username, encrypted_password
         FROM accounts WHERE is_active = 1 LIMIT 1"
    )?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(map_account_row(row)?));
    }
    Ok(None)
}

pub fn get_account_by_id(conn: &Connection, id: i64) -> Result<Option<Account>> {
    let mut stmt = conn.prepare(
        "SELECT id, email, provider, display_name, is_active,
                access_token, refresh_token, expires_at_epoch,
                imap_host, imap_port, smtp_host, smtp_port, username, encrypted_password
         FROM accounts WHERE id = ?1"
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(map_account_row(row)?));
    }
    Ok(None)
}

fn map_account_row(row: &rusqlite::Row<'_>) -> Result<Account> {
    Ok(Account {
        id: row.get(0)?,
        email: row.get(1)?,
        provider: row.get(2)?,
        display_name: row.get(3)?,
        is_active: row.get::<_, i64>(4)? != 0,
        access_token: row.get(5)?,
        refresh_token: row.get(6)?,
        expires_at_epoch: row.get(7)?,
        imap_host: row.get(8)?,
        imap_port: row.get(9)?,
        smtp_host: row.get(10)?,
        smtp_port: row.get(11)?,
        username: row.get(12)?,
        encrypted_password: row.get(13)?,
    })
}

pub fn set_active_account(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute("UPDATE accounts SET is_active = 0", [])?;
    conn.execute("UPDATE accounts SET is_active = 1 WHERE id = ?1", params![account_id])?;
    Ok(())
}

pub fn upsert_gmail_account(conn: &Connection, email: &str, token: &StoredToken) -> Result<i64> {
    conn.execute(
        "INSERT INTO accounts (email, provider, is_active, access_token, refresh_token, expires_at_epoch)
         VALUES (?1, 'gmail', 0, ?2, ?3, ?4)
         ON CONFLICT(email) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = COALESCE(excluded.refresh_token, accounts.refresh_token),
            expires_at_epoch = excluded.expires_at_epoch",
        params![email, token.access_token, token.refresh_token, token.expires_at_epoch],
    )?;
    let id = conn.query_row(
        "SELECT id FROM accounts WHERE email = ?1",
        params![email],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(id)
}

pub fn insert_imap_account(
    conn: &Connection,
    email: &str,
    display_name: Option<&str>,
    imap_host: &str,
    imap_port: i64,
    smtp_host: &str,
    smtp_port: i64,
    username: &str,
    encrypted_password: &str,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO accounts (email, provider, display_name, is_active, imap_host, imap_port, smtp_host, smtp_port, username, encrypted_password)
         VALUES (?1, 'imap', ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![email, display_name, imap_host, imap_port, smtp_host, smtp_port, username, encrypted_password],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn update_gmail_token(conn: &Connection, account_id: i64, token: &StoredToken) -> Result<()> {
    conn.execute(
        "UPDATE accounts SET access_token = ?1, refresh_token = COALESCE(?2, refresh_token), expires_at_epoch = ?3 WHERE id = ?4",
        params![token.access_token, token.refresh_token, token.expires_at_epoch, account_id],
    )?;
    Ok(())
}

pub fn delete_account(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute("DELETE FROM emails WHERE account_id = ?1", params![account_id])?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![account_id])?;
    Ok(())
}

pub fn update_account_email(conn: &Connection, account_id: i64, email: &str) -> Result<()> {
    conn.execute(
        "UPDATE accounts SET email = ?1 WHERE id = ?2",
        params![email, account_id],
    )?;
    Ok(())
}

pub fn clear_account_emails(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute("DELETE FROM emails WHERE account_id = ?1", params![account_id])?;
    Ok(())
}

pub fn clear_emails(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM emails", [])?;
    Ok(())
}

pub fn get_token(conn: &Connection) -> Result<Option<StoredToken>> {
    let account = get_active_account(conn)?;
    Ok(account.and_then(|a| {
        a.access_token.map(|at| StoredToken {
            access_token: at,
            refresh_token: a.refresh_token,
            expires_at_epoch: a.expires_at_epoch,
        })
    }))
}

pub fn clear_tokens(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE accounts SET access_token = NULL, refresh_token = NULL, expires_at_epoch = NULL WHERE is_active = 1",
        [],
    )?;
    Ok(())
}
