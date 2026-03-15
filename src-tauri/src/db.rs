use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Email {
    pub id: String,
    pub thread_id: String,
    pub subject: String,
    pub sender: String,
    pub body_html: String,
    pub date: String,
    pub is_read: bool,
}

pub fn init_db(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS emails (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            sender TEXT NOT NULL,
            body_html TEXT NOT NULL,
            date TEXT NOT NULL,
            is_read INTEGER NOT NULL
        )",
        [],
    )?;
    Ok(())
}
