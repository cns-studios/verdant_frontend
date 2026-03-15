use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
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
            thread_id TEXT,
            subject TEXT,
            sender TEXT,
            body_html TEXT,
            date TEXT,
            is_read INTEGER
        )",
        (),
    )?;
    Ok(())
}

