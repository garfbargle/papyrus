use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

mod sync;

type Result<T> = std::result::Result<T, String>;

struct AppState {
    db: Mutex<Connection>,
    identity: Mutex<sync::SyncIdentity>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Category {
    id: String,
    name: String,
    position: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    body: String,
    category_id: Option<String>,
    category_name: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    revision_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteListItem {
    id: String,
    title: String,
    category_id: Option<String>,
    category_name: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    revision_id: String,
    preview: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteInput {
    id: String,
    body: String,
    category_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictVersion {
    revision_id: String,
    title: String,
    body: String,
    category_id: Option<String>,
    updated_at: String,
    device_name: String,
    deleted_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteConflict {
    id: String,
    note_id: String,
    current: ConflictVersion,
    other: ConflictVersion,
}

fn error(error: rusqlite::Error) -> String {
    error.to_string()
}
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn make_id() -> String {
    Uuid::new_v4().to_string()
}

fn open_notebook(app: &AppHandle) -> Result<Connection> {
    #[cfg(debug_assertions)]
    let path = std::env::var_os("PAPYRUS_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(
            app.path()
                .app_data_dir()
                .map_err(|error| error.to_string())?,
        );
    #[cfg(not(debug_assertions))]
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    let connection = Connection::open(path.join("papyrus.sqlite3")).map_err(error)?;
    migrate(&connection)?;
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS categories (
           id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, position INTEGER NOT NULL,
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS notes (
           id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', category_id TEXT,
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, revision_id TEXT NOT NULL,
           FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL
         );
         CREATE INDEX IF NOT EXISTS notes_recency_idx ON notes(updated_at DESC);
         CREATE INDEX IF NOT EXISTS notes_deleted_idx ON notes(deleted_at);
         CREATE INDEX IF NOT EXISTS notes_category_idx ON notes(category_id);
         CREATE TABLE IF NOT EXISTS note_revisions (
           id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_revision_id TEXT, device_id TEXT,
           updated_at TEXT NOT NULL, content_hash TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
           category_id TEXT, deleted_at TEXT
         );
         CREATE INDEX IF NOT EXISTS revisions_note_idx ON note_revisions(note_id, updated_at DESC);
         CREATE TABLE IF NOT EXISTS deleted_items (item_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL, purge_after TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, display_name TEXT, public_key BLOB, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS device_authorizations (device_id TEXT PRIMARY KEY, authorized_at TEXT NOT NULL, revoked_at TEXT);
         CREATE TABLE IF NOT EXISTS sync_queue (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_receipts (id TEXT PRIMARY KEY, package_id TEXT NOT NULL, received_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, body, category_name);
         INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));"
    ).map_err(error)?;
    let version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    if version < 2 {
        migrate_categories_for_sync(connection)?;
    }
    let version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    if version < 3 {
        migrate_sync_schema(connection)?;
    }
    let version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    if version < 4 {
        migrate_notebook_archives(connection)?;
    }
    Ok(())
}

// Pre-pairing copies of the notebook. Deliberately outside every table
// `import_snapshot` clears, so adopting another vault can never be the last
// thing that happened to this device's notes.
fn migrate_notebook_archives(connection: &Connection) -> Result<()> {
    let transaction = connection.unchecked_transaction().map_err(error)?;
    transaction
        .execute_batch(
            "CREATE TABLE notebook_archives (
               id TEXT PRIMARY KEY, created_at TEXT NOT NULL, reason TEXT NOT NULL, snapshot TEXT NOT NULL
             );
             INSERT INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'));",
        )
        .map_err(error)?;
    transaction.commit().map_err(error)
}

fn migrate_categories_for_sync(connection: &Connection) -> Result<()> {
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(error)?;
    let migration = (|| -> Result<()> {
        let transaction = connection.unchecked_transaction().map_err(error)?;
        transaction.execute_batch(
            "DROP INDEX IF EXISTS notes_recency_idx;
             DROP INDEX IF EXISTS notes_deleted_idx;
             DROP INDEX IF EXISTS notes_category_idx;
             ALTER TABLE notes RENAME TO notes_legacy;
             ALTER TABLE categories RENAME TO categories_legacy;
             CREATE TABLE categories (
               id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, position INTEGER NOT NULL,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, revision_id TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE notes (
               id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', category_id TEXT,
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, revision_id TEXT NOT NULL,
               FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
             );
             INSERT INTO categories(id, name, position, created_at, updated_at, deleted_at, revision_id)
               SELECT id, name, position, created_at, updated_at, NULL, '' FROM categories_legacy;
             INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id)
               SELECT id, title, body, category_id, created_at, updated_at, deleted_at, revision_id FROM notes_legacy;
             DROP TABLE notes_legacy;
             DROP TABLE categories_legacy;
             CREATE INDEX notes_recency_idx ON notes(updated_at DESC);
             CREATE INDEX notes_deleted_idx ON notes(deleted_at);
             CREATE INDEX notes_category_idx ON notes(category_id);
             DELETE FROM notes_fts;
             INSERT INTO notes_fts(id, title, body, category_name)
               SELECT n.id, n.title, n.body, COALESCE(c.name, '') FROM notes n LEFT JOIN categories c ON c.id = n.category_id;
             INSERT INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));"
        ).map_err(error)?;
        transaction.commit().map_err(error)
    })();
    let reset = connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(error);
    migration?;
    reset
}

fn migrate_sync_schema(connection: &Connection) -> Result<()> {
    let transaction = connection.unchecked_transaction().map_err(error)?;
    transaction.execute_batch(
        "ALTER TABLE note_revisions ADD COLUMN created_at TEXT;
         ALTER TABLE note_revisions ADD COLUMN note_created_at TEXT;
         ALTER TABLE note_revisions ADD COLUMN purged_at TEXT;
         ALTER TABLE devices ADD COLUMN agreement_public_key BLOB;
         ALTER TABLE devices ADD COLUMN is_local INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE devices ADD COLUMN last_seen_at TEXT;
         UPDATE note_revisions SET created_at = COALESCE(created_at, updated_at), note_created_at = COALESCE(note_created_at, updated_at);
         UPDATE devices SET display_name = COALESCE(display_name, 'Unknown device');
         CREATE TABLE vaults (id TEXT PRIMARY KEY, key_epoch INTEGER NOT NULL, created_at TEXT NOT NULL);
         CREATE TABLE category_revisions (
           id TEXT PRIMARY KEY, category_id TEXT NOT NULL, parent_revision_id TEXT, device_id TEXT NOT NULL,
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, content_hash TEXT NOT NULL, name TEXT NOT NULL,
           position INTEGER NOT NULL, deleted_at TEXT
         );
         CREATE INDEX category_revisions_category_idx ON category_revisions(category_id, updated_at DESC);
         CREATE TABLE entity_heads (
           entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, revision_id TEXT NOT NULL,
           PRIMARY KEY(entity_type, entity_id)
         );
         INSERT OR IGNORE INTO entity_heads(entity_type, entity_id, revision_id) SELECT 'note', id, revision_id FROM notes;
         CREATE TABLE sync_outbox (
           id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, package_id TEXT NOT NULL UNIQUE, envelope TEXT NOT NULL,
           recipients TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
           next_retry_at TEXT NOT NULL, last_error TEXT, uploaded_at TEXT
         );
         CREATE INDEX sync_outbox_pending_idx ON sync_outbox(state, next_retry_at);
         CREATE UNIQUE INDEX sync_receipts_package_idx ON sync_receipts(package_id);
         CREATE TABLE sync_conflicts (
           id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, current_revision_id TEXT NOT NULL,
           other_revision_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
         );
         CREATE INDEX sync_conflicts_open_idx ON sync_conflicts(entity_type, entity_id, status);
         CREATE TABLE tombstones (
           entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, revision_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
           purged_at TEXT, PRIMARY KEY(entity_type, entity_id)
         );
         CREATE TABLE pairing_sessions (
           id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL,
           created_at TEXT NOT NULL, peer_device_id TEXT, peer_payload TEXT
         );
         INSERT INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'));"
    ).map_err(error)?;
    transaction.commit().map_err(error)
}

fn note_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        category_id: row.get(3)?,
        category_name: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        deleted_at: row.get(7)?,
        revision_id: row.get(8)?,
    })
}

fn markdown_title(body: &str) -> String {
    let Some(line) = body.lines().find(|line| !line.trim().is_empty()) else {
        return String::new();
    };
    let mut text = line.trim();
    text = text.trim_start_matches('#').trim_start();
    text = text.strip_prefix('>').unwrap_or(text).trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = text.strip_prefix(marker) {
            text = rest;
            break;
        }
    }
    if let Some((prefix, rest)) = text.split_once(". ") {
        if !prefix.is_empty() && prefix.chars().all(|character| character.is_ascii_digit()) {
            text = rest;
        }
    }
    text = text
        .strip_prefix("[ ] ")
        .or_else(|| text.strip_prefix("[x] "))
        .or_else(|| text.strip_prefix("[X] "))
        .unwrap_or(text);
    text.replace(['#', '*', '`', '>', '|', '_', '~'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect()
}

fn compact_preview(body: &str) -> String {
    let mut skipped_title = false;
    body.lines()
        .filter(|line| {
            if !skipped_title && !line.trim().is_empty() {
                skipped_title = true;
                return false;
            }
            skipped_title
        })
        .filter(|line| !line.trim_start().starts_with("```"))
        .map(|line| {
            line.replace("- [ ]", "")
                .replace("- [x]", "")
                .replace("- [X]", "")
        })
        .collect::<Vec<_>>()
        .join(" ")
        .replace(['#', '*', '`', '>', '|'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(155)
        .collect()
}

fn fts_query(value: &str) -> String {
    value
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn reindex_note(connection: &Connection, id: &str) -> Result<()> {
    let source: Option<(String, String, Option<String>)> = connection.query_row(
        "SELECT n.title, n.body, c.name FROM notes n LEFT JOIN categories c ON c.id = n.category_id WHERE n.id = ?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(error)?;
    connection
        .execute("DELETE FROM notes_fts WHERE id = ?1", [id])
        .map_err(error)?;
    if let Some((title, body, category_name)) = source {
        connection
            .execute(
                "INSERT INTO notes_fts(id, title, body, category_name) VALUES (?1, ?2, ?3, ?4)",
                params![id, title, body, category_name.unwrap_or_default()],
            )
            .map_err(error)?;
    }
    Ok(())
}

fn record_revision(
    connection: &Connection,
    identity: &sync::SyncIdentity,
    note: &Note,
    parent_revision_id: Option<String>,
    purged_at: Option<String>,
) -> Result<()> {
    let digest = sync::content_hash(
        &note.title,
        &note.body,
        note.category_id.as_deref(),
        note.deleted_at.as_deref(),
    );
    connection.execute(
        "INSERT INTO note_revisions(id, note_id, parent_revision_id, device_id, created_at, note_created_at, updated_at, content_hash, title, body, category_id, deleted_at, purged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![note.revision_id, note.id, parent_revision_id, identity.device_id, now(), note.created_at, note.updated_at, digest, note.title, note.body, note.category_id, note.deleted_at, purged_at],
    ).map_err(error)?;
    connection
        .execute(
            "INSERT INTO entity_heads(entity_type, entity_id, revision_id) VALUES ('note', ?1, ?2)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET revision_id = excluded.revision_id",
            params![note.id, note.revision_id],
        )
        .map_err(error)?;
    sync::enqueue_operation(
        connection,
        identity,
        &note.revision_id,
        sync::SyncOperation::NoteRevision(sync::NoteRevisionState {
            id: note.id.clone(),
            title: note.title.clone(),
            body: note.body.clone(),
            category_id: note.category_id.clone(),
            created_at: note.created_at.clone(),
            updated_at: note.updated_at.clone(),
            deleted_at: note.deleted_at.clone(),
            purged_at,
            revision_id: note.revision_id.clone(),
            parent_revision_id,
        }),
    )?;
    Ok(())
}

fn record_category_revision(
    connection: &Connection,
    identity: &sync::SyncIdentity,
    category: &Category,
    parent_revision_id: Option<String>,
    deleted_at: Option<String>,
    revision_id: String,
) -> Result<()> {
    let digest = sync::content_hash(&category.name, "", None, deleted_at.as_deref());
    connection.execute(
        "INSERT INTO category_revisions(id, category_id, parent_revision_id, device_id, created_at, updated_at, content_hash, name, position, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![revision_id, category.id, parent_revision_id, identity.device_id, now(), category.updated_at, digest, category.name, category.position, deleted_at],
    ).map_err(error)?;
    connection
        .execute(
            "UPDATE categories SET revision_id = ?2 WHERE id = ?1",
            params![category.id, revision_id],
        )
        .map_err(error)?;
    connection.execute(
        "INSERT INTO entity_heads(entity_type, entity_id, revision_id) VALUES ('category', ?1, ?2)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET revision_id = excluded.revision_id",
        params![category.id, revision_id],
    ).map_err(error)?;
    sync::enqueue_operation(
        connection,
        identity,
        &revision_id,
        sync::SyncOperation::CategoryRevision(sync::CategoryRevisionState {
            id: category.id.clone(),
            name: category.name.clone(),
            position: category.position,
            created_at: category.created_at.clone(),
            updated_at: category.updated_at.clone(),
            deleted_at,
            revision_id: revision_id.clone(),
            parent_revision_id,
        }),
    )
}

fn backfill_sync_history(connection: &Connection, identity: &sync::SyncIdentity) -> Result<()> {
    let transaction = connection.unchecked_transaction().map_err(error)?;
    transaction
        .execute(
            "UPDATE note_revisions SET device_id = ?1 WHERE device_id IS NULL",
            [&identity.device_id],
        )
        .map_err(error)?;
    let mut statement = transaction.prepare("SELECT id, name, position, created_at, updated_at FROM categories WHERE revision_id = ''").map_err(error)?;
    let categories = statement
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                position: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    drop(statement);
    for category in categories {
        let revision_id = make_id();
        let digest = sync::content_hash(&category.name, "", None, None);
        transaction.execute(
            "INSERT INTO category_revisions(id, category_id, parent_revision_id, device_id, created_at, updated_at, content_hash, name, position, deleted_at)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
            params![revision_id, category.id, identity.device_id, category.updated_at, category.updated_at, digest, category.name, category.position],
        ).map_err(error)?;
        transaction
            .execute(
                "UPDATE categories SET revision_id = ?2 WHERE id = ?1",
                params![category.id, revision_id],
            )
            .map_err(error)?;
        transaction.execute("INSERT OR REPLACE INTO entity_heads(entity_type, entity_id, revision_id) VALUES ('category', ?1, ?2)", params![category.id, revision_id]).map_err(error)?;
    }
    transaction.commit().map_err(error)
}

fn permanently_delete_note(
    connection: &Connection,
    identity: &sync::SyncIdentity,
    id: &str,
) -> Result<()> {
    let Some(previous) = find_note(connection, id)? else {
        return Ok(());
    };
    let deleted_at = previous.deleted_at.clone().unwrap_or_else(now);
    let purged_at = now();
    let tombstone = Note {
        deleted_at: Some(deleted_at.clone()),
        updated_at: purged_at.clone(),
        revision_id: make_id(),
        ..previous.clone()
    };
    record_revision(
        connection,
        identity,
        &tombstone,
        Some(previous.revision_id),
        Some(purged_at.clone()),
    )?;
    connection.execute("INSERT OR REPLACE INTO tombstones(entity_type, entity_id, revision_id, deleted_at, purged_at) VALUES ('note', ?1, ?2, ?3, ?4)", params![id, tombstone.revision_id, deleted_at, purged_at]).map_err(error)?;
    connection
        .execute("DELETE FROM notes_fts WHERE id = ?1", [id])
        .map_err(error)?;
    connection
        .execute("DELETE FROM notes WHERE id = ?1", [id])
        .map_err(error)?;
    connection
        .execute("DELETE FROM deleted_items WHERE item_id = ?1", [id])
        .map_err(error)?;
    Ok(())
}

fn cleanup_expired_trash(connection: &Connection, identity: &sync::SyncIdentity) -> Result<()> {
    let cutoff = (Utc::now() - Duration::days(30)).to_rfc3339();
    let mut statement = connection
        .prepare("SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?1")
        .map_err(error)?;
    let ids = statement
        .query_map([cutoff], |row| row.get::<_, String>(0))
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    drop(statement);
    for id in ids {
        permanently_delete_note(connection, identity, &id)?;
    }
    Ok(())
}

fn find_note(connection: &Connection, id: &str) -> Result<Option<Note>> {
    connection.query_row(
        "SELECT n.id, n.title, n.body, n.category_id, c.name, n.created_at, n.updated_at, n.deleted_at, n.revision_id
         FROM notes n LEFT JOIN categories c ON c.id = n.category_id WHERE n.id = ?1", [id], note_from_row,
    ).optional().map_err(error)
}

#[tauri::command]
fn initialize_database(state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    cleanup_expired_trash(&connection, &identity)
}

#[tauri::command]
fn list_categories(state: State<'_, AppState>) -> Result<Vec<Category>> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let mut statement = connection.prepare("SELECT id, name, position, created_at, updated_at FROM categories WHERE deleted_at IS NULL ORDER BY position, name COLLATE NOCASE").map_err(error)?;
    let categories = statement
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                position: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(categories)
}

#[tauri::command]
fn create_category(name: String, state: State<'_, AppState>) -> Result<Category> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A category needs a name.".into());
    }
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let position: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM categories WHERE deleted_at IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    let category = Category {
        id: make_id(),
        name: name.to_owned(),
        position,
        created_at: now(),
        updated_at: now(),
    };
    transaction.execute("INSERT INTO categories(id, name, position, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, NULL, '')", params![category.id, category.name, category.position, category.created_at, category.updated_at]).map_err(error)?;
    record_category_revision(&transaction, &identity, &category, None, None, make_id())?;
    transaction.commit().map_err(error)?;
    Ok(category)
}

fn find_category_with_revision(
    connection: &Connection,
    id: &str,
) -> Result<Option<(Category, String)>> {
    connection.query_row(
        "SELECT id, name, position, created_at, updated_at, revision_id FROM categories WHERE id = ?1 AND deleted_at IS NULL",
        [id], |row| Ok((Category { id: row.get(0)?, name: row.get(1)?, position: row.get(2)?, created_at: row.get(3)?, updated_at: row.get(4)? }, row.get(5)?)),
    ).optional().map_err(error)
}

#[tauri::command]
fn rename_category(id: String, name: String, state: State<'_, AppState>) -> Result<Category> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A category needs a name.".into());
    }
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let Some((mut category, parent)) = find_category_with_revision(&transaction, &id)? else {
        return Err("That folder is no longer available.".into());
    };
    category.name = name.to_string();
    category.updated_at = now();
    transaction
        .execute(
            "UPDATE categories SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, category.name, category.updated_at],
        )
        .map_err(error)?;
    record_category_revision(
        &transaction,
        &identity,
        &category,
        Some(parent),
        None,
        make_id(),
    )?;
    transaction
        .execute(
            "DELETE FROM notes_fts WHERE id IN (SELECT id FROM notes WHERE category_id = ?1)",
            [&id],
        )
        .map_err(error)?;
    transaction.execute("INSERT INTO notes_fts(id, title, body, category_name) SELECT n.id, n.title, n.body, ?2 FROM notes n WHERE n.category_id = ?1", params![id, category.name]).map_err(error)?;
    transaction.commit().map_err(error)?;
    Ok(category)
}

#[tauri::command]
fn move_category(id: String, direction: i64, state: State<'_, AppState>) -> Result<Vec<Category>> {
    if direction != -1 && direction != 1 {
        return Err("Choose a valid folder direction.".into());
    }
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let Some((mut category, parent)) = find_category_with_revision(&transaction, &id)? else {
        return Err("That folder is no longer available.".into());
    };
    let neighbor_id: Option<String> = if direction < 0 {
        transaction.query_row("SELECT id FROM categories WHERE deleted_at IS NULL AND position < ?1 ORDER BY position DESC LIMIT 1", [category.position], |row| row.get(0)).optional().map_err(error)?
    } else {
        transaction.query_row("SELECT id FROM categories WHERE deleted_at IS NULL AND position > ?1 ORDER BY position LIMIT 1", [category.position], |row| row.get(0)).optional().map_err(error)?
    };
    let Some(neighbor_id) = neighbor_id else {
        return list_categories_from(&transaction);
    };
    let Some((mut neighbor, neighbor_parent)) =
        find_category_with_revision(&transaction, &neighbor_id)?
    else {
        return Err("The neighboring folder is no longer available.".into());
    };
    std::mem::swap(&mut category.position, &mut neighbor.position);
    category.updated_at = now();
    neighbor.updated_at = category.updated_at.clone();
    transaction
        .execute(
            "UPDATE categories SET position = ?2, updated_at = ?3 WHERE id = ?1",
            params![category.id, category.position, category.updated_at],
        )
        .map_err(error)?;
    transaction
        .execute(
            "UPDATE categories SET position = ?2, updated_at = ?3 WHERE id = ?1",
            params![neighbor.id, neighbor.position, neighbor.updated_at],
        )
        .map_err(error)?;
    record_category_revision(
        &transaction,
        &identity,
        &category,
        Some(parent),
        None,
        make_id(),
    )?;
    record_category_revision(
        &transaction,
        &identity,
        &neighbor,
        Some(neighbor_parent),
        None,
        make_id(),
    )?;
    transaction.commit().map_err(error)?;
    list_categories_from(&connection)
}

fn list_categories_from(connection: &Connection) -> Result<Vec<Category>> {
    let mut statement = connection.prepare("SELECT id, name, position, created_at, updated_at FROM categories WHERE deleted_at IS NULL ORDER BY position, name COLLATE NOCASE").map_err(error)?;
    let categories = statement
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                position: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(categories)
}

#[tauri::command]
fn delete_category(id: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let Some((mut category, parent)) = find_category_with_revision(&transaction, &id)? else {
        return Ok(());
    };
    let deleted_at = now();
    category.updated_at = deleted_at.clone();
    transaction
        .execute(
            "UPDATE categories SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![id, deleted_at],
        )
        .map_err(error)?;
    record_category_revision(
        &transaction,
        &identity,
        &category,
        Some(parent),
        Some(deleted_at),
        make_id(),
    )?;
    let mut statement = transaction.prepare("SELECT n.id, n.title, n.body, n.category_id, c.name, n.created_at, n.updated_at, n.deleted_at, n.revision_id FROM notes n LEFT JOIN categories c ON c.id = n.category_id WHERE n.category_id = ?1").map_err(error)?;
    let notes = statement
        .query_map([&id], note_from_row)
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    drop(statement);
    for previous in notes {
        let mut next = previous.clone();
        next.category_id = None;
        next.category_name = None;
        next.updated_at = now();
        next.revision_id = make_id();
        transaction.execute("UPDATE notes SET category_id = NULL, updated_at = ?2, revision_id = ?3 WHERE id = ?1", params![next.id, next.updated_at, next.revision_id]).map_err(error)?;
        record_revision(
            &transaction,
            &identity,
            &next,
            Some(previous.revision_id),
            None,
        )?;
        reindex_note(&transaction, &next.id)?;
    }
    transaction.commit().map_err(error)
}

#[tauri::command]
fn list_notes(
    filter: String,
    search: String,
    state: State<'_, AppState>,
) -> Result<Vec<NoteListItem>> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let query = fts_query(&search);
    let mut sql = "SELECT n.id, n.title, n.body, n.category_id, c.name, n.created_at, n.updated_at, n.deleted_at, n.revision_id FROM notes n LEFT JOIN categories c ON c.id = n.category_id".to_string();
    let mut clauses: Vec<&str> = Vec::new();
    if !query.is_empty() {
        sql.push_str(" JOIN notes_fts fts ON fts.id = n.id");
        clauses.push("fts MATCH ?1");
    }
    if filter == "trash" {
        clauses.push("n.deleted_at IS NOT NULL");
    } else {
        clauses.push("n.deleted_at IS NULL");
        if filter != "all" {
            clauses.push(if query.is_empty() {
                "n.category_id = ?1"
            } else {
                "n.category_id = ?2"
            });
        }
    }
    sql.push_str(" WHERE ");
    sql.push_str(&clauses.join(" AND "));
    sql.push_str(" ORDER BY n.updated_at DESC");
    let mut statement = connection.prepare(&sql).map_err(error)?;
    let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<NoteListItem> {
        let body: String = row.get(2)?;
        let stored_title: String = row.get(1)?;
        let derived_title = markdown_title(&body);
        Ok(NoteListItem {
            id: row.get(0)?,
            title: if derived_title.is_empty() {
                stored_title
            } else {
                derived_title
            },
            preview: compact_preview(&body),
            category_id: row.get(3)?,
            category_name: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            deleted_at: row.get(7)?,
            revision_id: row.get(8)?,
        })
    };
    let rows = if query.is_empty() && filter != "all" && filter != "trash" {
        statement.query_map([filter], read)
    } else if !query.is_empty() && filter != "all" && filter != "trash" {
        statement.query_map(params![query, filter], read)
    } else if !query.is_empty() {
        statement.query_map([query], read)
    } else {
        statement.query_map([], read)
    }
    .map_err(error)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)
}

#[tauri::command]
fn get_note(id: String, state: State<'_, AppState>) -> Result<Option<Note>> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    find_note(&connection, &id)
}

fn conflict_version(
    connection: &Connection,
    revision_id: &str,
    fallback_name: &str,
) -> Result<ConflictVersion> {
    connection.query_row(
        "SELECT r.id, r.title, r.body, r.category_id, r.updated_at, COALESCE(d.display_name, ?2), r.deleted_at
         FROM note_revisions r LEFT JOIN devices d ON d.id = r.device_id WHERE r.id = ?1",
        params![revision_id, fallback_name],
        |row| Ok(ConflictVersion { revision_id: row.get(0)?, title: row.get(1)?, body: row.get(2)?, category_id: row.get(3)?, updated_at: row.get(4)?, device_name: row.get(5)?, deleted_at: row.get(6)? }),
    ).map_err(error)
}

#[tauri::command]
fn get_note_conflict(id: String, state: State<'_, AppState>) -> Result<Option<NoteConflict>> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let conflict: Option<(String, String, String)> = connection.query_row(
        "SELECT id, current_revision_id, other_revision_id FROM sync_conflicts
         WHERE entity_type = 'note' AND entity_id = ?1 AND status = 'open' ORDER BY created_at DESC LIMIT 1",
        [&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(error)?;
    let Some((conflict_id, current_revision_id, other_revision_id)) = conflict else {
        return Ok(None);
    };
    Ok(Some(NoteConflict {
        id: conflict_id,
        note_id: id,
        current: conflict_version(&connection, &current_revision_id, "This device")?,
        other: conflict_version(&connection, &other_revision_id, "Another device")?,
    }))
}

fn conflict_copy_body(body: &str, title: &str, device_name: &str) -> String {
    let base = if title.trim().is_empty() {
        "Untitled note"
    } else {
        title.trim()
    };
    let heading = format!("# {base} — Conflict from {device_name}");
    let mut lines = body.lines().map(str::to_string).collect::<Vec<_>>();
    if let Some(index) = lines.iter().position(|line| !line.trim().is_empty()) {
        if markdown_title(&lines[index]) == base {
            lines[index] = heading;
            return lines.join("\n");
        }
    }
    if body.trim().is_empty() {
        heading
    } else {
        format!("{heading}\n\n{body}")
    }
}

#[tauri::command]
fn resolve_note_conflict(
    id: String,
    resolution: String,
    state: State<'_, AppState>,
) -> Result<Note> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    resolve_note_conflict_in(&connection, &identity, &id, &resolution)
}

fn resolve_note_conflict_in(
    connection: &Connection,
    identity: &sync::SyncIdentity,
    id: &str,
    resolution: &str,
) -> Result<Note> {
    if !matches!(resolution, "current" | "other" | "both") {
        return Err("Choose how to resolve these versions.".into());
    }
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let conflict: Option<(String, String, String)> = transaction.query_row(
        "SELECT id, current_revision_id, other_revision_id FROM sync_conflicts
         WHERE entity_type = 'note' AND entity_id = ?1 AND status = 'open' ORDER BY created_at DESC LIMIT 1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(error)?;
    let Some((_conflict_id, _current_revision_id, other_revision_id)) = conflict else {
        return Err("This conflict has already been resolved.".into());
    };
    let visible = find_note(&transaction, id)?
        .ok_or_else(|| "The conflicted note is no longer available.".to_string())?;
    let other = conflict_version(&transaction, &other_revision_id, "Another device")?;

    if resolution == "both" {
        let timestamp = now();
        let copy = Note {
            id: make_id(),
            title: format!(
                "{} — Conflict from {}",
                if other.title.trim().is_empty() {
                    "Untitled note"
                } else {
                    other.title.trim()
                },
                other.device_name
            ),
            body: conflict_copy_body(&other.body, &other.title, &other.device_name),
            category_id: other.category_id.clone(),
            category_name: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            deleted_at: None,
            revision_id: make_id(),
        };
        transaction.execute(
            "INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            params![copy.id, copy.title, copy.body, copy.category_id, copy.created_at, copy.updated_at, copy.revision_id],
        ).map_err(error)?;
        record_revision(&transaction, identity, &copy, None, None)?;
        reindex_note(&transaction, &copy.id)?;
    }

    let mut resolved = visible.clone();
    if resolution == "other" {
        resolved.title = other.title;
        resolved.body = other.body;
        resolved.category_id = other.category_id;
        resolved.deleted_at = other.deleted_at;
    }
    resolved.updated_at = now();
    resolved.revision_id = make_id();
    transaction.execute(
        "UPDATE notes SET title = ?2, body = ?3, category_id = ?4, updated_at = ?5, deleted_at = ?6, revision_id = ?7 WHERE id = ?1",
        params![resolved.id, resolved.title, resolved.body, resolved.category_id, resolved.updated_at, resolved.deleted_at, resolved.revision_id],
    ).map_err(error)?;
    if let Some(deleted_at) = &resolved.deleted_at {
        transaction.execute(
            "INSERT OR REPLACE INTO deleted_items(item_id, deleted_at, purge_after) VALUES (?1, ?2, ?3)",
            params![resolved.id, deleted_at, (Utc::now() + Duration::days(30)).to_rfc3339()],
        ).map_err(error)?;
    } else {
        transaction
            .execute(
                "DELETE FROM deleted_items WHERE item_id = ?1",
                [&resolved.id],
            )
            .map_err(error)?;
    }
    // Parenting the resolution to the competing branch makes the next package converge on the peer that created it.
    record_revision(
        &transaction,
        identity,
        &resolved,
        Some(other_revision_id),
        None,
    )?;
    reindex_note(&transaction, &resolved.id)?;
    transaction.execute(
        "UPDATE sync_conflicts SET status = 'resolved', resolved_at = ?2 WHERE entity_type = 'note' AND entity_id = ?1 AND status = 'open'",
        params![id, now()],
    ).map_err(error)?;
    transaction.commit().map_err(error)?;
    find_note(connection, id)?.ok_or_else(|| "The resolved note could not be loaded.".to_string())
}

#[tauri::command]
fn save_note(note: NoteInput, state: State<'_, AppState>) -> Result<Note> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let previous = find_note(&transaction, &note.id)?;
    let timestamp = now();
    let revision_id = make_id();
    let title = markdown_title(&note.body);
    let saved = Note {
        id: note.id,
        title,
        body: note.body,
        category_id: note.category_id,
        category_name: None,
        created_at: previous
            .as_ref()
            .map(|item| item.created_at.clone())
            .unwrap_or_else(|| timestamp.clone()),
        updated_at: timestamp,
        deleted_at: previous.as_ref().and_then(|item| item.deleted_at.clone()),
        revision_id,
    };
    if previous.is_some() {
        transaction.execute("UPDATE notes SET title = ?2, body = ?3, category_id = ?4, updated_at = ?5, revision_id = ?6 WHERE id = ?1", params![saved.id, saved.title, saved.body, saved.category_id, saved.updated_at, saved.revision_id]).map_err(error)?;
    } else {
        transaction.execute("INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)", params![saved.id, saved.title, saved.body, saved.category_id, saved.created_at, saved.updated_at, saved.revision_id]).map_err(error)?;
    }
    record_revision(
        &transaction,
        &identity,
        &saved,
        previous.map(|item| item.revision_id),
        None,
    )?;
    reindex_note(&transaction, &saved.id)?;
    transaction.commit().map_err(error)?;
    find_note(&connection, &saved.id)?.ok_or_else(|| "Saved note could not be loaded.".to_string())
}

#[tauri::command]
fn move_note(id: String, category_id: Option<String>, state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let Some(previous) = find_note(&transaction, &id)? else {
        return Ok(());
    };
    let mut next = previous.clone();
    next.category_id = category_id;
    next.updated_at = now();
    next.revision_id = make_id();
    transaction
        .execute(
            "UPDATE notes SET category_id = ?2, updated_at = ?3, revision_id = ?4 WHERE id = ?1",
            params![id, next.category_id, next.updated_at, next.revision_id],
        )
        .map_err(error)?;
    record_revision(
        &transaction,
        &identity,
        &next,
        Some(previous.revision_id),
        None,
    )?;
    reindex_note(&transaction, &id)?;
    transaction.commit().map_err(error)
}

#[tauri::command]
fn trash_note(id: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let Some(previous) = find_note(&transaction, &id)? else {
        return Ok(());
    };
    let mut next = previous.clone();
    next.deleted_at = Some(now());
    next.updated_at = now();
    next.revision_id = make_id();
    transaction
        .execute(
            "UPDATE notes SET deleted_at = ?2, updated_at = ?3, revision_id = ?4 WHERE id = ?1",
            params![id, next.deleted_at, next.updated_at, next.revision_id],
        )
        .map_err(error)?;
    transaction.execute("INSERT OR REPLACE INTO deleted_items(item_id, deleted_at, purge_after) VALUES (?1, ?2, ?3)", params![id, next.deleted_at, (Utc::now() + Duration::days(30)).to_rfc3339()]).map_err(error)?;
    record_revision(
        &transaction,
        &identity,
        &next,
        Some(previous.revision_id),
        None,
    )?;
    reindex_note(&transaction, &id)?;
    transaction.commit().map_err(error)
}

#[tauri::command]
fn restore_note(id: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let Some(previous) = find_note(&transaction, &id)? else {
        return Ok(());
    };
    let mut next = previous.clone();
    next.deleted_at = None;
    next.updated_at = now();
    next.revision_id = make_id();
    transaction
        .execute(
            "UPDATE notes SET deleted_at = NULL, updated_at = ?2, revision_id = ?3 WHERE id = ?1",
            params![id, next.updated_at, next.revision_id],
        )
        .map_err(error)?;
    transaction
        .execute("DELETE FROM deleted_items WHERE item_id = ?1", [&id])
        .map_err(error)?;
    record_revision(
        &transaction,
        &identity,
        &next,
        Some(previous.revision_id),
        None,
    )?;
    reindex_note(&transaction, &id)?;
    transaction.commit().map_err(error)
}

#[tauri::command]
fn delete_note_permanently(id: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    permanently_delete_note(&transaction, &identity, &id)?;
    transaction.commit().map_err(error)
}

#[tauri::command]
fn empty_trash(state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let mut statement = transaction
        .prepare("SELECT id FROM notes WHERE deleted_at IS NOT NULL")
        .map_err(error)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    drop(statement);
    for id in ids {
        permanently_delete_note(&transaction, &identity, &id)?;
    }
    transaction.commit().map_err(error)
}

#[tauri::command]
fn duplicate_note(id: String, state: State<'_, AppState>) -> Result<Note> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let source = find_note(&transaction, &id)?.ok_or_else(|| "Note not found.".to_string())?;
    let timestamp = now();
    let copy = Note {
        id: make_id(),
        title: markdown_title(&source.body),
        body: source.body,
        category_id: source.category_id,
        category_name: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        deleted_at: None,
        revision_id: make_id(),
    };
    transaction.execute("INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)", params![copy.id, copy.title, copy.body, copy.category_id, copy.created_at, copy.updated_at, copy.revision_id]).map_err(error)?;
    record_revision(&transaction, &identity, &copy, None, None)?;
    reindex_note(&transaction, &copy.id)?;
    transaction.commit().map_err(error)?;
    find_note(&connection, &copy.id)?.ok_or_else(|| "Duplicate could not be loaded.".to_string())
}

fn safe_component(input: &str, fallback: &str) -> String {
    let cleaned = input
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == ' '
                || character == '-'
                || character == '_'
            {
                character
            } else {
                ' '
            }
        })
        .collect::<String>();
    let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        fallback.into()
    } else {
        compact.chars().take(90).collect()
    }
}

#[tauri::command]
fn embed_image(path: String) -> Result<String> {
    let source = PathBuf::from(&path);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err("Choose a PNG, JPEG, GIF, or WebP image.".into()),
    };
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    const MAX_INLINE_IMAGE_SIZE: usize = 4 * 1024 * 1024;
    if bytes.len() > MAX_INLINE_IMAGE_SIZE {
        return Err("Choose an image smaller than 4 MB for inline use.".into());
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
fn get_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    connection
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(error)
}

#[tauri::command]
fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    connection.execute("INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(error)?;
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SyncDevice {
    id: String,
    display_name: String,
    is_current_device: bool,
    revoked_at: Option<String>,
    last_seen_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncStatus {
    status: String,
    last_successful_sync: Option<String>,
    pending_outgoing_changes: i64,
    devices: Vec<SyncDevice>,
    local_device_name: String,
    attention_message: Option<String>,
    open_conflicts: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadPackage {
    vault_id: String,
    sender_device_id: String,
    envelope: sync::SyncEnvelope,
    recipients: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchPackages {
    vault_id: String,
    device_id: String,
    limit: u8,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgePackage {
    vault_id: String,
    device_id: String,
    package_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayPackage {
    package_id: String,
    envelope: sync::SyncEnvelope,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayFetchResponse {
    packages: Vec<RelayPackage>,
}

#[derive(Debug)]
struct PendingOutbox {
    id: String,
    envelope: sync::SyncEnvelope,
    recipients: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingCode {
    version: u8,
    relay_url: String,
    session_id: String,
    secret: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingOffer {
    code: String,
    expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingProgress {
    ready: bool,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingStartRequest {
    vault_id: String,
    session_id: String,
    secret_hash: String,
    expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingHelloRequest {
    session_id: String,
    secret: String,
    device_id: String,
    display_name: String,
    signing_key: String,
    agreement_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingClaimRequest {
    vault_id: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingClaimResponse {
    ready: bool,
    device_id: Option<String>,
    display_name: Option<String>,
    signing_key: Option<String>,
    agreement_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingCompleteRequest {
    session_id: String,
    device_id: String,
    sealed_payload: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingFinishRequest {
    session_id: String,
    secret: String,
    device_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingFinishResponse {
    ready: bool,
    sealed_payload: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RevokeDeviceRequest {
    vault_id: String,
    device_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotCategory {
    id: String,
    name: String,
    position: i64,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    revision_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotNoteRevision {
    id: String,
    note_id: String,
    parent_revision_id: Option<String>,
    device_id: String,
    created_at: String,
    note_created_at: String,
    updated_at: String,
    content_hash: String,
    title: String,
    body: String,
    category_id: Option<String>,
    deleted_at: Option<String>,
    purged_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotCategoryRevision {
    id: String,
    category_id: String,
    parent_revision_id: Option<String>,
    device_id: String,
    created_at: String,
    updated_at: String,
    content_hash: String,
    name: String,
    position: i64,
    deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotDevice {
    id: String,
    display_name: String,
    signing_key: String,
    agreement_key: String,
    created_at: String,
    authorized_at: String,
    revoked_at: Option<String>,
    last_seen_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotHead {
    entity_type: String,
    entity_id: String,
    revision_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotTombstone {
    entity_type: String,
    entity_id: String,
    revision_id: String,
    deleted_at: String,
    purged_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotConflict {
    id: String,
    entity_type: String,
    entity_id: String,
    current_revision_id: String,
    other_revision_id: String,
    status: String,
    created_at: String,
    resolved_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotebookSnapshot {
    version: u8,
    vault_id: String,
    vault_key_epoch: i64,
    vault_key: String,
    notes: Vec<Note>,
    categories: Vec<SnapshotCategory>,
    note_revisions: Vec<SnapshotNoteRevision>,
    category_revisions: Vec<SnapshotCategoryRevision>,
    devices: Vec<SnapshotDevice>,
    heads: Vec<SnapshotHead>,
    tombstones: Vec<SnapshotTombstone>,
    conflicts: Vec<SnapshotConflict>,
}

fn sync_state(connection: &Connection, key: &str) -> Result<Option<String>> {
    connection
        .query_row(
            "SELECT value FROM sync_state WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(error)
}

fn set_sync_state(connection: &Connection, key: &str, value: &str) -> Result<()> {
    connection.execute("INSERT INTO sync_state(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(error)?;
    Ok(())
}

fn configured_relay(connection: &Connection) -> Result<Option<String>> {
    if let Some(url) = sync_state(connection, "relay_url")? {
        return Ok(Some(url));
    }
    if let Some(url) = option_env!("PAPYRUS_SYNC_RELAY_URL") {
        return Ok(Some(url.to_string()));
    }
    #[cfg(debug_assertions)]
    return Ok(Some("http://127.0.0.1:8787".to_string()));
    // The public relay is part of the app's normal release configuration. The
    // compile-time value above remains available for staging builds, but a
    // sideloaded Mac or Android release must work out of the box.
    #[cfg(not(debug_assertions))]
    Ok(Some(
        "https://papyrus-sync-relay.c0di.workers.dev".to_string(),
    ))
}

fn sync_status(connection: &Connection, identity: &sync::SyncIdentity) -> Result<SyncStatus> {
    let pending: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_outbox WHERE state = 'pending'",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    let devices = connection.prepare(
        "SELECT d.id, d.display_name, d.is_local, a.revoked_at, d.last_seen_at
         FROM devices d LEFT JOIN device_authorizations a ON a.device_id = d.id ORDER BY d.is_local DESC, d.created_at"
    ).map_err(error)?.query_map([], |row| Ok(SyncDevice {
        id: row.get(0)?, display_name: row.get(1)?, is_current_device: row.get::<_, i64>(2)? != 0, revoked_at: row.get(3)?, last_seen_at: row.get(4)?,
    })).map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    let last_successful_sync = sync_state(connection, "last_successful_sync")?;
    let open_conflicts: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_conflicts WHERE status = 'open'",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    let network_attention =
        sync_state(connection, "last_sync_error")?.filter(|message| !message.is_empty());
    let attention_message = if open_conflicts > 0 {
        Some(format!(
            "Review {open_conflicts} sync conflict{} to make sure no work is lost.",
            if open_conflicts == 1 { "" } else { "s" }
        ))
    } else {
        network_attention
    };
    let paired = devices
        .iter()
        .filter(|device| !device.is_current_device && device.revoked_at.is_none())
        .count();
    let status = if attention_message.is_some() {
        "Attention required"
    } else if paired == 0 || configured_relay(connection)?.is_none() {
        "Offline"
    } else if pending > 0 {
        "Changes pending"
    } else {
        "Synced"
    }
    .to_string();
    Ok(SyncStatus {
        status,
        last_successful_sync,
        pending_outgoing_changes: pending,
        devices,
        local_device_name: identity.device_name.clone(),
        attention_message,
        open_conflicts,
    })
}

trait SyncTransport {
    fn upload(&self, identity: &sync::SyncIdentity, payload: &UploadPackage) -> Result<()>;
    fn fetch(
        &self,
        identity: &sync::SyncIdentity,
        payload: &FetchPackages,
    ) -> Result<RelayFetchResponse>;
    fn acknowledge(
        &self,
        identity: &sync::SyncIdentity,
        payload: &AcknowledgePackage,
    ) -> Result<()>;
}

struct RelayTransport {
    base_url: String,
    client: reqwest::blocking::Client,
}

impl RelayTransport {
    fn new(base_url: &str) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|_| "Could not initialize secure sync networking.".to_string())?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client,
        })
    }

    fn post<T: DeserializeOwned, P: Serialize>(
        &self,
        identity: &sync::SyncIdentity,
        path: &str,
        payload: &P,
    ) -> Result<T> {
        let body = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
        let proof = sync::transport_proof(identity, "POST", path, &body);
        let response = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .header("content-type", "application/json")
            .header("x-papyrus-device", proof.device_id)
            .header("x-papyrus-signing-key", proof.signing_key)
            .header("x-papyrus-timestamp", proof.timestamp)
            .header("x-papyrus-signature", proof.signature)
            .body(body)
            .send()
            .map_err(|_| {
                "The sync service is unavailable. Your changes remain safely on this device."
                    .to_string()
            })?;
        if !response.status().is_success() {
            return Err(
                if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
                    "This device is no longer authorized to sync this notebook.".into()
                } else {
                    "The sync service could not accept this request.".into()
                },
            );
        }
        response
            .json::<T>()
            .map_err(|_| "The sync service returned an invalid response.".into())
    }
}

impl SyncTransport for RelayTransport {
    fn upload(&self, identity: &sync::SyncIdentity, payload: &UploadPackage) -> Result<()> {
        self.post::<serde_json::Value, _>(identity, "/v1/packages", payload)
            .map(|_| ())
    }
    fn fetch(
        &self,
        identity: &sync::SyncIdentity,
        payload: &FetchPackages,
    ) -> Result<RelayFetchResponse> {
        self.post(identity, "/v1/packages/fetch", payload)
    }
    fn acknowledge(
        &self,
        identity: &sync::SyncIdentity,
        payload: &AcknowledgePackage,
    ) -> Result<()> {
        self.post::<serde_json::Value, _>(identity, "/v1/packages/ack", payload)
            .map(|_| ())
    }
}

fn encode_pairing_code(code: &PairingCode) -> Result<String> {
    let bytes = serde_json::to_vec(code).map_err(|error| error.to_string())?;
    Ok(format!("papyrus-pair-v1:{}", URL_SAFE_NO_PAD.encode(bytes)))
}

fn decode_pairing_code(value: &str) -> Result<PairingCode> {
    let encoded = value
        .trim()
        .strip_prefix("papyrus-pair-v1:")
        .ok_or_else(|| "This is not a Papyrus pairing code.".to_string())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "This pairing code is invalid.".to_string())?;
    let code: PairingCode =
        serde_json::from_slice(&bytes).map_err(|_| "This pairing code is invalid.".to_string())?;
    if code.version != 1
        || DateTime::parse_from_rfc3339(&code.expires_at)
            .map_err(|_| "This pairing code is invalid.".to_string())?
            .with_timezone(&Utc)
            <= Utc::now()
    {
        return Err("This pairing code has expired. Create a new one on your other device.".into());
    }
    Ok(code)
}

fn build_snapshot(
    connection: &Connection,
    identity: &sync::SyncIdentity,
) -> Result<NotebookSnapshot> {
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let notes = transaction.prepare("SELECT n.id, n.title, n.body, n.category_id, c.name, n.created_at, n.updated_at, n.deleted_at, n.revision_id FROM notes n LEFT JOIN categories c ON c.id = n.category_id")
        .map_err(error)?.query_map([], note_from_row).map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    let categories = transaction.prepare("SELECT id, name, position, created_at, updated_at, deleted_at, revision_id FROM categories")
        .map_err(error)?.query_map([], |row| Ok(SnapshotCategory { id: row.get(0)?, name: row.get(1)?, position: row.get(2)?, created_at: row.get(3)?, updated_at: row.get(4)?, deleted_at: row.get(5)?, revision_id: row.get(6)? }))
        .map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    let note_revisions = transaction.prepare("SELECT id, note_id, parent_revision_id, COALESCE(device_id, ?1), COALESCE(created_at, updated_at), COALESCE(note_created_at, updated_at), updated_at, content_hash, title, body, category_id, deleted_at, purged_at FROM note_revisions")
        .map_err(error)?.query_map([&identity.device_id], |row| Ok(SnapshotNoteRevision { id: row.get(0)?, note_id: row.get(1)?, parent_revision_id: row.get(2)?, device_id: row.get(3)?, created_at: row.get(4)?, note_created_at: row.get(5)?, updated_at: row.get(6)?, content_hash: row.get(7)?, title: row.get(8)?, body: row.get(9)?, category_id: row.get(10)?, deleted_at: row.get(11)?, purged_at: row.get(12)? }))
        .map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    let category_revisions = transaction.prepare("SELECT id, category_id, parent_revision_id, device_id, created_at, updated_at, content_hash, name, position, deleted_at FROM category_revisions")
        .map_err(error)?.query_map([], |row| Ok(SnapshotCategoryRevision { id: row.get(0)?, category_id: row.get(1)?, parent_revision_id: row.get(2)?, device_id: row.get(3)?, created_at: row.get(4)?, updated_at: row.get(5)?, content_hash: row.get(6)?, name: row.get(7)?, position: row.get(8)?, deleted_at: row.get(9)? }))
        .map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    let devices = transaction.prepare("SELECT d.id, d.display_name, d.public_key, d.agreement_public_key, d.created_at, a.authorized_at, a.revoked_at, d.last_seen_at FROM devices d JOIN device_authorizations a ON a.device_id = d.id")
        .map_err(error)?.query_map([], |row| { let signing: Vec<u8> = row.get(2)?; let agreement: Vec<u8> = row.get(3)?; Ok(SnapshotDevice { id: row.get(0)?, display_name: row.get(1)?, signing_key: URL_SAFE_NO_PAD.encode(signing), agreement_key: URL_SAFE_NO_PAD.encode(agreement), created_at: row.get(4)?, authorized_at: row.get(5)?, revoked_at: row.get(6)?, last_seen_at: row.get(7)? }) })
        .map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    let heads = transaction
        .prepare("SELECT entity_type, entity_id, revision_id FROM entity_heads")
        .map_err(error)?
        .query_map([], |row| {
            Ok(SnapshotHead {
                entity_type: row.get(0)?,
                entity_id: row.get(1)?,
                revision_id: row.get(2)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    let tombstones = transaction
        .prepare(
            "SELECT entity_type, entity_id, revision_id, deleted_at, purged_at FROM tombstones",
        )
        .map_err(error)?
        .query_map([], |row| {
            Ok(SnapshotTombstone {
                entity_type: row.get(0)?,
                entity_id: row.get(1)?,
                revision_id: row.get(2)?,
                deleted_at: row.get(3)?,
                purged_at: row.get(4)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    let conflicts = transaction.prepare("SELECT id, entity_type, entity_id, current_revision_id, other_revision_id, status, created_at, resolved_at FROM sync_conflicts")
        .map_err(error)?.query_map([], |row| Ok(SnapshotConflict { id: row.get(0)?, entity_type: row.get(1)?, entity_id: row.get(2)?, current_revision_id: row.get(3)?, other_revision_id: row.get(4)?, status: row.get(5)?, created_at: row.get(6)?, resolved_at: row.get(7)? }))
        .map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    transaction.commit().map_err(error)?;
    Ok(NotebookSnapshot {
        version: 1,
        vault_id: identity.vault_id.clone(),
        vault_key_epoch: identity.vault_key_epoch,
        vault_key: URL_SAFE_NO_PAD.encode(identity.vault_key),
        notes,
        categories,
        note_revisions,
        category_revisions,
        devices,
        heads,
        tombstones,
        conflicts,
    })
}

// --- Pairing archive + merge --------------------------------------------------

struct CarriedCategory {
    category: Category,
    deleted_at: Option<String>,
}

struct CarriedNotebook {
    notes: Vec<Note>,
    categories: Vec<CarriedCategory>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayCounts {
    notes: usize,
    categories: usize,
}

// The working copies this device owns before it adopts another vault. Trashed
// notes come along too — they belong to the user just as much, and `deleted_at`
// rides through the replay so they land back in the trash.
fn collect_local_notebook(connection: &Connection) -> Result<CarriedNotebook> {
    let mut statement = connection.prepare(
        "SELECT n.id, n.title, n.body, n.category_id, c.name, n.created_at, n.updated_at, n.deleted_at, n.revision_id
         FROM notes n LEFT JOIN categories c ON c.id = n.category_id",
    ).map_err(error)?;
    let notes = statement
        .query_map([], note_from_row)
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    drop(statement);
    let mut statement = connection
        .prepare(
            "SELECT id, name, position, created_at, updated_at, deleted_at FROM categories ORDER BY position",
        )
        .map_err(error)?;
    let categories = statement
        .query_map([], |row| {
            Ok(CarriedCategory {
                category: Category {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    position: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                },
                deleted_at: row.get(5)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    drop(statement);
    Ok(CarriedNotebook { notes, categories })
}

// A full pre-pairing copy, written to a table `import_snapshot` does not clear,
// so a merge that fails halfway leaves the old notebook recoverable.
fn archive_notebook(
    connection: &Connection,
    identity: &sync::SyncIdentity,
    reason: &str,
) -> Result<String> {
    let snapshot = serde_json::to_string(&build_snapshot(connection, identity)?)
        .map_err(|_| "Could not archive this device's notebook.".to_string())?;
    let id = make_id();
    connection
        .execute(
            "INSERT INTO notebook_archives(id, created_at, reason, snapshot) VALUES (?1, ?2, ?3, ?4)",
            params![id, now(), reason, snapshot],
        )
        .map_err(error)?;
    Ok(id)
}

// Re-record a carried notebook as fresh root revisions under the adopted vault,
// which also enqueues them for the vault's other devices.
//
// The carried revision ancestry is deliberately dropped: it only ever existed on
// this device, so no peer could resolve it — `apply_remote_note` rejects a
// revision whose parent it has never seen. A root revision (no parent) applies
// cleanly on every device instead. Entity ids are UUIDs, so they cannot collide
// with the adopted vault's own notes; an id that somehow does already exist is
// left alone rather than forked into a conflict.
fn replay_notebook(
    connection: &Connection,
    identity: &sync::SyncIdentity,
    carried: CarriedNotebook,
) -> Result<ReplayCounts> {
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let position_offset: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM categories",
            [],
            |row| row.get(0),
        )
        .map_err(error)?;
    let mut counts = ReplayCounts {
        notes: 0,
        categories: 0,
    };
    for (index, carried_category) in carried.categories.into_iter().enumerate() {
        let CarriedCategory {
            category,
            deleted_at,
        } = carried_category;
        if entity_exists(&transaction, "categories", &category.id)? {
            continue;
        }
        let category = Category {
            position: position_offset + index as i64,
            ..category
        };
        let revision_id = make_id();
        transaction.execute(
            "INSERT INTO categories(id, name, position, created_at, updated_at, deleted_at, revision_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![category.id, category.name, category.position, category.created_at, category.updated_at, deleted_at, revision_id],
        ).map_err(error)?;
        record_category_revision(&transaction, identity, &category, None, deleted_at, revision_id)?;
        counts.categories += 1;
    }
    for note in carried.notes {
        if entity_exists(&transaction, "notes", &note.id)? {
            continue;
        }
        let note = Note {
            revision_id: make_id(),
            ..note
        };
        transaction.execute(
            "INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![note.id, note.title, note.body, note.category_id, note.created_at, note.updated_at, note.deleted_at, note.revision_id],
        ).map_err(error)?;
        record_revision(&transaction, identity, &note, None, None)?;
        reindex_note(&transaction, &note.id)?;
        counts.notes += 1;
    }
    transaction.commit().map_err(error)?;
    Ok(counts)
}

fn entity_exists(connection: &Connection, table: &str, id: &str) -> Result<bool> {
    let found: Option<i64> = connection
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(error)?;
    Ok(found.is_some())
}

fn import_snapshot(
    connection: &Connection,
    identity: &mut sync::SyncIdentity,
    snapshot: NotebookSnapshot,
    relay_url: &str,
) -> Result<ReplayCounts> {
    if snapshot.version != 1 {
        return Err("This notebook snapshot uses a newer Papyrus version.".into());
    }
    let vault_key: [u8; 32] = URL_SAFE_NO_PAD
        .decode(&snapshot.vault_key)
        .map_err(|_| "The paired notebook key is invalid.".to_string())?
        .as_slice()
        .try_into()
        .map_err(|_| "The paired notebook key is invalid.".to_string())?;
    if !snapshot
        .devices
        .iter()
        .any(|device| device.id == identity.device_id && device.revoked_at.is_none())
    {
        return Err("The paired notebook did not authorize this device.".into());
    }
    let mut adopted = identity.clone();
    sync::adopt_vault(
        &mut adopted,
        snapshot.vault_id.clone(),
        snapshot.vault_key_epoch,
        vault_key,
    )?;

    // Pairing merges rather than replaces: hold on to this device's notebook and
    // archive it before the rewrite below, then replay what we held once the
    // vault is adopted. Both happen outside that transaction — the archive has to
    // be durable even if the import fails, and the replay has to seal its
    // operations with the adopted vault key.
    let carried = collect_local_notebook(connection)?;
    archive_notebook(connection, identity, "Before pairing with an existing notebook")?;

    let transaction = connection.unchecked_transaction().map_err(error)?;
    transaction.execute_batch(
        "DELETE FROM notes_fts; DELETE FROM notes; DELETE FROM categories; DELETE FROM note_revisions;
         DELETE FROM category_revisions; DELETE FROM entity_heads; DELETE FROM tombstones; DELETE FROM sync_conflicts;
         DELETE FROM sync_outbox; DELETE FROM sync_receipts; DELETE FROM devices; DELETE FROM device_authorizations; DELETE FROM vaults;"
    ).map_err(error)?;
    transaction
        .execute(
            "INSERT INTO vaults(id, key_epoch, created_at) VALUES (?1, ?2, ?3)",
            params![snapshot.vault_id, snapshot.vault_key_epoch, now()],
        )
        .map_err(error)?;
    for category in snapshot.categories {
        transaction.execute("INSERT INTO categories(id, name, position, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![category.id, category.name, category.position, category.created_at, category.updated_at, category.deleted_at, category.revision_id]).map_err(error)?;
    }
    for note in snapshot.notes {
        transaction.execute("INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", params![note.id, note.title, note.body, note.category_id, note.created_at, note.updated_at, note.deleted_at, note.revision_id]).map_err(error)?;
    }
    for revision in snapshot.note_revisions {
        transaction.execute("INSERT INTO note_revisions(id, note_id, parent_revision_id, device_id, created_at, note_created_at, updated_at, content_hash, title, body, category_id, deleted_at, purged_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)", params![revision.id, revision.note_id, revision.parent_revision_id, revision.device_id, revision.created_at, revision.note_created_at, revision.updated_at, revision.content_hash, revision.title, revision.body, revision.category_id, revision.deleted_at, revision.purged_at]).map_err(error)?;
    }
    for revision in snapshot.category_revisions {
        transaction.execute("INSERT INTO category_revisions(id, category_id, parent_revision_id, device_id, created_at, updated_at, content_hash, name, position, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)", params![revision.id, revision.category_id, revision.parent_revision_id, revision.device_id, revision.created_at, revision.updated_at, revision.content_hash, revision.name, revision.position, revision.deleted_at]).map_err(error)?;
    }
    for device in snapshot.devices {
        let signing_key = URL_SAFE_NO_PAD
            .decode(device.signing_key)
            .map_err(|_| "A paired device has an invalid signing key.".to_string())?;
        let agreement_key = URL_SAFE_NO_PAD
            .decode(device.agreement_key)
            .map_err(|_| "A paired device has an invalid agreement key.".to_string())?;
        if signing_key.len() != 32 || agreement_key.len() != 32 {
            return Err("A paired device has an invalid key.".into());
        }
        transaction.execute("INSERT INTO devices(id, display_name, public_key, agreement_public_key, created_at, is_local, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![device.id, device.display_name, signing_key, agreement_key, device.created_at, if device.id == identity.device_id { 1 } else { 0 }, device.last_seen_at]).map_err(error)?;
        transaction.execute("INSERT INTO device_authorizations(device_id, authorized_at, revoked_at) VALUES (?1, ?2, ?3)", params![device.id, device.authorized_at, device.revoked_at]).map_err(error)?;
    }
    for head in snapshot.heads {
        transaction
            .execute(
                "INSERT INTO entity_heads(entity_type, entity_id, revision_id) VALUES (?1, ?2, ?3)",
                params![head.entity_type, head.entity_id, head.revision_id],
            )
            .map_err(error)?;
    }
    for tombstone in snapshot.tombstones {
        transaction.execute("INSERT INTO tombstones(entity_type, entity_id, revision_id, deleted_at, purged_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![tombstone.entity_type, tombstone.entity_id, tombstone.revision_id, tombstone.deleted_at, tombstone.purged_at]).map_err(error)?;
    }
    for conflict in snapshot.conflicts {
        transaction.execute("INSERT INTO sync_conflicts(id, entity_type, entity_id, current_revision_id, other_revision_id, status, created_at, resolved_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", params![conflict.id, conflict.entity_type, conflict.entity_id, conflict.current_revision_id, conflict.other_revision_id, conflict.status, conflict.created_at, conflict.resolved_at]).map_err(error)?;
    }
    transaction.execute("INSERT INTO notes_fts(id, title, body, category_name) SELECT n.id, n.title, n.body, COALESCE(c.name, '') FROM notes n LEFT JOIN categories c ON c.id = n.category_id", []).map_err(error)?;
    transaction.execute("INSERT INTO sync_state(key, value) VALUES ('relay_url', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [relay_url]).map_err(error)?;
    transaction
        .execute(
            "DELETE FROM sync_state WHERE key IN ('last_sync_error', 'inbound_cursor')",
            [],
        )
        .map_err(error)?;
    transaction.commit().map_err(error)?;
    *identity = adopted;
    replay_notebook(connection, identity, carried)
}

fn pending_outbox(connection: &Connection) -> Result<Vec<PendingOutbox>> {
    let mut statement = connection.prepare("SELECT id, envelope, recipients FROM sync_outbox WHERE state = 'pending' AND next_retry_at <= ?1 ORDER BY created_at LIMIT 32").map_err(error)?;
    let rows = statement
        .query_map([now()], |row| {
            let envelope: String = row.get(1)?;
            let recipients: String = row.get(2)?;
            Ok((row.get::<_, String>(0)?, envelope, recipients))
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    rows.into_iter()
        .map(|(id, envelope, recipients)| {
            Ok(PendingOutbox {
                id,
                envelope: serde_json::from_str(&envelope)
                    .map_err(|_| "A local sync package is invalid.".to_string())?,
                recipients: serde_json::from_str(&recipients)
                    .map_err(|_| "A local sync recipient list is invalid.".to_string())?,
            })
        })
        .collect()
}

fn mark_outbox_uploaded(connection: &Connection, id: &str) -> Result<()> {
    connection.execute("UPDATE sync_outbox SET state = 'uploaded', uploaded_at = ?2, last_error = NULL WHERE id = ?1", params![id, now()]).map_err(error)?;
    Ok(())
}

fn delay_outbox(connection: &Connection, id: &str, message: &str) -> Result<()> {
    let attempts: i64 = connection
        .query_row(
            "SELECT attempts FROM sync_outbox WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(error)?;
    let seconds = (15_i64 * (attempts + 1)).min(15 * 60);
    connection.execute("UPDATE sync_outbox SET attempts = attempts + 1, next_retry_at = ?2, last_error = ?3 WHERE id = ?1", params![id, (Utc::now() + Duration::seconds(seconds)).to_rfc3339(), message]).map_err(error)?;
    Ok(())
}

fn note_revision_exists(connection: &Connection, revision_id: &str) -> Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM note_revisions WHERE id = ?1",
            [revision_id],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(error)
}

fn category_revision_exists(connection: &Connection, revision_id: &str) -> Result<bool> {
    connection
        .query_row(
            "SELECT 1 FROM category_revisions WHERE id = ?1",
            [revision_id],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(error)
}

fn is_note_ancestor(connection: &Connection, ancestor: &str, descendant: &str) -> Result<bool> {
    let mut current = Some(descendant.to_string());
    for _ in 0..10_000 {
        let Some(revision) = current else {
            return Ok(false);
        };
        if revision == ancestor {
            return Ok(true);
        }
        current = connection
            .query_row(
                "SELECT parent_revision_id FROM note_revisions WHERE id = ?1",
                [revision],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?
            .flatten();
    }
    Err("The note revision history is too deep to verify safely.".into())
}

fn is_category_ancestor(connection: &Connection, ancestor: &str, descendant: &str) -> Result<bool> {
    let mut current = Some(descendant.to_string());
    for _ in 0..10_000 {
        let Some(revision) = current else {
            return Ok(false);
        };
        if revision == ancestor {
            return Ok(true);
        }
        current = connection
            .query_row(
                "SELECT parent_revision_id FROM category_revisions WHERE id = ?1",
                [revision],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?
            .flatten();
    }
    Err("The category revision history is too deep to verify safely.".into())
}

fn replace_note_working_copy(
    connection: &Connection,
    state: &sync::NoteRevisionState,
) -> Result<()> {
    if state.purged_at.is_some() {
        let deleted_at = state.deleted_at.clone().unwrap_or_else(now);
        connection.execute("INSERT OR REPLACE INTO tombstones(entity_type, entity_id, revision_id, deleted_at, purged_at) VALUES ('note', ?1, ?2, ?3, ?4)", params![state.id, state.revision_id, deleted_at, state.purged_at]).map_err(error)?;
        connection
            .execute("DELETE FROM notes_fts WHERE id = ?1", [&state.id])
            .map_err(error)?;
        connection
            .execute("DELETE FROM notes WHERE id = ?1", [&state.id])
            .map_err(error)?;
        connection
            .execute("DELETE FROM deleted_items WHERE item_id = ?1", [&state.id])
            .map_err(error)?;
        return Ok(());
    }
    if let Some(category_id) = &state.category_id {
        let exists = connection
            .query_row(
                "SELECT 1 FROM categories WHERE id = ?1 AND deleted_at IS NULL",
                [category_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(error)?
            .is_some();
        if !exists {
            return Err("A note package arrived before its category revision.".into());
        }
    }
    connection.execute(
        "INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, category_id = excluded.category_id, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, revision_id = excluded.revision_id",
        params![state.id, state.title, state.body, state.category_id, state.created_at, state.updated_at, state.deleted_at, state.revision_id],
    ).map_err(error)?;
    if let Some(deleted_at) = &state.deleted_at {
        connection.execute("INSERT OR REPLACE INTO deleted_items(item_id, deleted_at, purge_after) VALUES (?1, ?2, ?3)", params![state.id, deleted_at, (Utc::now() + Duration::days(30)).to_rfc3339()]).map_err(error)?;
    } else {
        connection
            .execute("DELETE FROM deleted_items WHERE item_id = ?1", [&state.id])
            .map_err(error)?;
    }
    reindex_note(connection, &state.id)
}

fn apply_remote_note(
    connection: &Connection,
    state: &sync::NoteRevisionState,
    sender_device_id: &str,
) -> Result<()> {
    if note_revision_exists(connection, &state.revision_id)? {
        return Ok(());
    }
    if let Some(parent) = &state.parent_revision_id {
        if !note_revision_exists(connection, parent)? {
            return Err("A note package arrived before its parent revision.".into());
        }
    }
    let digest = sync::content_hash(
        &state.title,
        &state.body,
        state.category_id.as_deref(),
        state.deleted_at.as_deref(),
    );
    connection.execute(
        "INSERT INTO note_revisions(id, note_id, parent_revision_id, device_id, created_at, note_created_at, updated_at, content_hash, title, body, category_id, deleted_at, purged_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![state.revision_id, state.id, state.parent_revision_id, sender_device_id, state.updated_at, state.created_at, state.updated_at, digest, state.title, state.body, state.category_id, state.deleted_at, state.purged_at],
    ).map_err(error)?;
    let current: Option<String> = connection
        .query_row(
            "SELECT revision_id FROM entity_heads WHERE entity_type = 'note' AND entity_id = ?1",
            [&state.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(error)?;
    let apply = match current.as_deref() {
        None => true,
        Some(head) if state.parent_revision_id.as_deref() == Some(head) => true,
        Some(head) if is_note_ancestor(connection, head, &state.revision_id)? => true,
        Some(head) if is_note_ancestor(connection, &state.revision_id, head)? => false,
        Some(head) => {
            connection.execute("INSERT INTO sync_conflicts(id, entity_type, entity_id, current_revision_id, other_revision_id, status, created_at) VALUES (?1, 'note', ?2, ?3, ?4, 'open', ?5)", params![make_id(), state.id, head, state.revision_id, now()]).map_err(error)?;
            false
        }
    };
    if apply {
        replace_note_working_copy(connection, state)?;
        connection.execute("INSERT INTO entity_heads(entity_type, entity_id, revision_id) VALUES ('note', ?1, ?2) ON CONFLICT(entity_type, entity_id) DO UPDATE SET revision_id = excluded.revision_id", params![state.id, state.revision_id]).map_err(error)?;
    }
    Ok(())
}

fn apply_remote_category(
    connection: &Connection,
    state: &sync::CategoryRevisionState,
    sender_device_id: &str,
) -> Result<()> {
    if category_revision_exists(connection, &state.revision_id)? {
        return Ok(());
    }
    if let Some(parent) = &state.parent_revision_id {
        if !category_revision_exists(connection, parent)? {
            return Err("A category package arrived before its parent revision.".into());
        }
    }
    let digest = sync::content_hash(&state.name, "", None, state.deleted_at.as_deref());
    connection.execute("INSERT INTO category_revisions(id, category_id, parent_revision_id, device_id, created_at, updated_at, content_hash, name, position, deleted_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)", params![state.revision_id, state.id, state.parent_revision_id, sender_device_id, state.updated_at, state.updated_at, digest, state.name, state.position, state.deleted_at]).map_err(error)?;
    let current: Option<String> = connection.query_row("SELECT revision_id FROM entity_heads WHERE entity_type = 'category' AND entity_id = ?1", [&state.id], |row| row.get(0)).optional().map_err(error)?;
    let apply = match current.as_deref() {
        None => true,
        Some(head) if state.parent_revision_id.as_deref() == Some(head) => true,
        Some(head) if is_category_ancestor(connection, head, &state.revision_id)? => true,
        Some(head) if is_category_ancestor(connection, &state.revision_id, head)? => false,
        Some(head) => {
            connection.execute("INSERT INTO sync_conflicts(id, entity_type, entity_id, current_revision_id, other_revision_id, status, created_at) VALUES (?1, 'category', ?2, ?3, ?4, 'open', ?5)", params![make_id(), state.id, head, state.revision_id, now()]).map_err(error)?;
            false
        }
    };
    if apply {
        connection.execute("INSERT INTO categories(id, name, position, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET name = excluded.name, position = excluded.position, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, revision_id = excluded.revision_id", params![state.id, state.name, state.position, state.created_at, state.updated_at, state.deleted_at, state.revision_id]).map_err(error)?;
        connection.execute("INSERT INTO entity_heads(entity_type, entity_id, revision_id) VALUES ('category', ?1, ?2) ON CONFLICT(entity_type, entity_id) DO UPDATE SET revision_id = excluded.revision_id", params![state.id, state.revision_id]).map_err(error)?;
        connection
            .execute(
                "DELETE FROM notes_fts WHERE id IN (SELECT id FROM notes WHERE category_id = ?1)",
                [&state.id],
            )
            .map_err(error)?;
        connection.execute("INSERT INTO notes_fts(id, title, body, category_name) SELECT n.id, n.title, n.body, COALESCE(c.name, '') FROM notes n LEFT JOIN categories c ON c.id = n.category_id WHERE n.category_id = ?1", [&state.id]).map_err(error)?;
    }
    Ok(())
}

fn apply_remote_operation(
    connection: &Connection,
    envelope: &sync::SyncEnvelope,
    operation: sync::SyncOperation,
) -> Result<Option<sync::VaultKeyRotation>> {
    let transaction = connection.unchecked_transaction().map_err(error)?;
    let already_received = transaction
        .query_row(
            "SELECT 1 FROM sync_receipts WHERE package_id = ?1",
            [&envelope.package_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(error)?
        .is_some();
    if already_received {
        return Ok(None);
    }
    let rotation = match operation {
        sync::SyncOperation::NoteRevision(state) => {
            apply_remote_note(&transaction, &state, &envelope.sender_device_id)?;
            None
        }
        sync::SyncOperation::CategoryRevision(state) => {
            apply_remote_category(&transaction, &state, &envelope.sender_device_id)?;
            None
        }
        sync::SyncOperation::DeviceAuthorization(device) => {
            let signing_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(device.signing_public_key)
                .map_err(|_| "Invalid paired-device signing key.".to_string())?;
            let agreement_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(device.agreement_public_key)
                .map_err(|_| "Invalid paired-device agreement key.".to_string())?;
            transaction.execute("INSERT INTO devices(id, display_name, public_key, agreement_public_key, created_at, is_local) VALUES (?1, ?2, ?3, ?4, ?5, 0) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, public_key = excluded.public_key, agreement_public_key = excluded.agreement_public_key", params![device.device_id, device.display_name, signing_key, agreement_key, device.authorized_at]).map_err(error)?;
            transaction.execute("INSERT INTO device_authorizations(device_id, authorized_at, revoked_at) VALUES (?1, ?2, NULL) ON CONFLICT(device_id) DO UPDATE SET authorized_at = excluded.authorized_at, revoked_at = NULL", params![device.device_id, device.authorized_at]).map_err(error)?;
            None
        }
        sync::SyncOperation::DeviceRevocation(device) => {
            transaction
                .execute(
                    "UPDATE device_authorizations SET revoked_at = ?2 WHERE device_id = ?1",
                    params![device.device_id, device.revoked_at],
                )
                .map_err(error)?;
            None
        }
        sync::SyncOperation::VaultKeyRotation(rotation) => {
            let current_epoch: i64 = transaction
                .query_row(
                    "SELECT key_epoch FROM vaults WHERE id = ?1",
                    [&envelope.vault_id],
                    |row| row.get(0),
                )
                .map_err(error)?;
            if rotation.epoch <= current_epoch {
                None
            } else if rotation.epoch != current_epoch + 1 {
                return Err("A vault-key rotation arrived out of order.".into());
            } else {
                transaction
                    .execute(
                        "UPDATE vaults SET key_epoch = ?2 WHERE id = ?1",
                        params![envelope.vault_id, rotation.epoch],
                    )
                    .map_err(error)?;
                Some(rotation)
            }
        }
    };
    transaction
        .execute(
            "INSERT INTO sync_receipts(id, package_id, received_at) VALUES (?1, ?2, ?3)",
            params![make_id(), envelope.package_id, now()],
        )
        .map_err(error)?;
    transaction.commit().map_err(error)?;
    Ok(rotation)
}

fn run_sync_cycle(state: &AppState) -> Result<SyncStatus> {
    let mut identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?
        .clone();
    let relay_url = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        let active_devices: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM device_authorizations WHERE revoked_at IS NULL",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        if active_devices <= 1 {
            return sync_status(&connection, &identity);
        }
        configured_relay(&connection)?
    };
    let Some(relay_url) = relay_url else {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        return sync_status(&connection, &identity);
    };
    let transport = RelayTransport::new(&relay_url)?;
    {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        set_sync_state(&connection, "last_sync_error", "")?;
        set_sync_state(&connection, "more_inbound_packages", "0")?;
    }
    let outgoing = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        pending_outbox(&connection)?
    };
    for item in outgoing {
        if item.recipients.is_empty() {
            let connection = state
                .db
                .lock()
                .map_err(|_| "Notebook is busy".to_string())?;
            connection
                .execute(
                    "UPDATE sync_outbox SET state = 'waiting_for_device' WHERE id = ?1",
                    [&item.id],
                )
                .map_err(error)?;
            continue;
        }
        let payload = UploadPackage {
            vault_id: identity.vault_id.clone(),
            sender_device_id: identity.device_id.clone(),
            envelope: item.envelope,
            recipients: item.recipients,
        };
        let result = transport.upload(&identity, &payload);
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        match result {
            Ok(_) => mark_outbox_uploaded(&connection, &item.id)?,
            Err(message) => {
                delay_outbox(&connection, &item.id, &message)?;
                set_sync_state(&connection, "last_sync_error", &message)?;
            }
        }
    }
    let fetch = FetchPackages {
        vault_id: identity.vault_id.clone(),
        device_id: identity.device_id.clone(),
        limit: 32,
    };
    let fetched: RelayFetchResponse = match transport.fetch(&identity, &fetch) {
        Ok(response) => response,
        Err(message) => {
            let connection = state
                .db
                .lock()
                .map_err(|_| "Notebook is busy".to_string())?;
            set_sync_state(&connection, "last_sync_error", &message)?;
            return sync_status(&connection, &identity);
        }
    };
    {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        // A full page is the relay's signal that another pull may be needed.
        // Preserve it so `sync_now` can drain a newly paired notebook instead
        // of falsely reporting success after the first 32 packages.
        set_sync_state(
            &connection,
            "more_inbound_packages",
            if fetched.packages.len() == 32 { "1" } else { "0" },
        )?;
    }
    for remote in fetched.packages {
        if remote.package_id != remote.envelope.package_id {
            continue;
        }
        let expected_key = {
            let connection = state
                .db
                .lock()
                .map_err(|_| "Notebook is busy".to_string())?;
            connection.query_row("SELECT d.public_key FROM devices d JOIN device_authorizations a ON a.device_id = d.id WHERE d.id = ?1 AND a.revoked_at IS NULL", [&remote.envelope.sender_device_id], |row| row.get::<_, Vec<u8>>(0)).optional().map_err(error)?
        };
        let Some(expected_key) = expected_key else {
            continue;
        };
        let operation = match sync::decrypt_operation(&identity, &remote.envelope, &expected_key) {
            Ok(operation) => operation,
            Err(message) => {
                // A package sealed with an epoch older than our current vault key
                // that we no longer hold predates this device's view of the vault
                // (e.g. traffic the relay still held from before we joined or
                // before a key rotation). It can never be decrypted, so acknowledge
                // it to clear the inbox instead of retrying forever and pinning a
                // permanent sync error.
                if remote.envelope.key_epoch < identity.vault_key_epoch {
                    let acknowledgment = AcknowledgePackage {
                        vault_id: identity.vault_id.clone(),
                        device_id: identity.device_id.clone(),
                        package_id: remote.package_id.clone(),
                    };
                    let _ = transport.acknowledge(&identity, &acknowledgment);
                } else {
                    let connection = state
                        .db
                        .lock()
                        .map_err(|_| "Notebook is busy".to_string())?;
                    set_sync_state(&connection, "last_sync_error", &message)?;
                }
                continue;
            }
        };
        let applied = {
            let connection = state
                .db
                .lock()
                .map_err(|_| "Notebook is busy".to_string())?;
            apply_remote_operation(&connection, &remote.envelope, operation)
        };
        match applied {
            Ok(rotation) => {
                if let Some(rotation) = rotation {
                    let key: [u8; 32] = URL_SAFE_NO_PAD
                        .decode(&rotation.vault_key)
                        .map_err(|_| "A rotated vault key is invalid.".to_string())?
                        .as_slice()
                        .try_into()
                        .map_err(|_| "A rotated vault key is invalid.".to_string())?;
                    let mut live_identity = state
                        .identity
                        .lock()
                        .map_err(|_| "Sync identity is busy".to_string())?;
                    sync::adopt_vault(
                        &mut live_identity,
                        identity.vault_id.clone(),
                        rotation.epoch,
                        key,
                    )?;
                    identity = live_identity.clone();
                }
                let acknowledgment = AcknowledgePackage {
                    vault_id: identity.vault_id.clone(),
                    device_id: identity.device_id.clone(),
                    package_id: remote.package_id,
                };
                let _ = transport.acknowledge(&identity, &acknowledgment);
            }
            Err(message) => {
                let connection = state
                    .db
                    .lock()
                    .map_err(|_| "Notebook is busy".to_string())?;
                set_sync_state(&connection, "last_sync_error", &message)?;
            }
        }
    }
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    if sync_state(&connection, "last_sync_error")?.is_none_or(|message| message.is_empty()) {
        set_sync_state(&connection, "last_successful_sync", &now())?;
    }
    sync_status(&connection, &identity)
}

#[tauri::command]
fn get_sync_status(state: State<'_, AppState>) -> Result<SyncStatus> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    sync_status(&connection, &identity)
}

#[tauri::command]
fn sync_now(state: State<'_, AppState>) -> Result<SyncStatus> {
    // Packages are deliberately sent in bounded pages. A foreground sync must
    // nevertheless drain those pages before claiming the notebook is current.
    // Stop if a retryable failure leaves the outbox unchanged, and keep a hard
    // ceiling so a pathological relay cannot monopolize the UI indefinitely.
    let mut previous_pending = None;
    let mut status = run_sync_cycle(&state)?;
    for _ in 0..31 {
        let more_inbound = {
            let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
            sync_state(&connection, "more_inbound_packages")?.as_deref() == Some("1")
        };
        let outbox_progressed = previous_pending.is_none_or(|pending| pending != status.pending_outgoing_changes);
        if !more_inbound && (status.pending_outgoing_changes == 0 || !outbox_progressed) {
            break;
        }
        previous_pending = Some(status.pending_outgoing_changes);
        status = run_sync_cycle(&state)?;
    }
    Ok(status)
}

#[tauri::command]
fn rename_sync_device(name: String, state: State<'_, AppState>) -> Result<SyncStatus> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A device needs a name.".into());
    }
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let mut identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    connection
        .execute(
            "UPDATE devices SET display_name = ?2 WHERE id = ?1",
            params![identity.device_id, name],
        )
        .map_err(error)?;
    identity.device_name = name.to_string();
    sync_status(&connection, &identity)
}

#[tauri::command]
fn remove_sync_device(device_id: String, state: State<'_, AppState>) -> Result<SyncStatus> {
    let old_identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?
        .clone();
    if device_id == old_identity.device_id {
        return Err(
            "This device cannot remove itself. Remove it from another paired device.".into(),
        );
    }
    let relay_url = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        let active = connection
            .query_row(
                "SELECT 1 FROM device_authorizations WHERE device_id = ?1 AND revoked_at IS NULL",
                [&device_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(error)?
            .is_some();
        if !active {
            return Err("That device is already removed.".into());
        }
        configured_relay(&connection)?
    }
    .ok_or_else(|| "Papyrus Sync is not configured in this build.".to_string())?;
    let _: serde_json::Value = RelayTransport::new(&relay_url)?.post(
        &old_identity,
        "/v1/devices/revoke",
        &RevokeDeviceRequest {
            vault_id: old_identity.vault_id.clone(),
            device_id: device_id.clone(),
        },
    )?;
    let new_key_bytes = sync::random_bytes(32);
    let new_key: [u8; 32] = new_key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "Could not create a replacement vault key.".to_string())?;
    let next_epoch = old_identity.vault_key_epoch + 1;
    let mut rotated_identity = old_identity.clone();
    sync::adopt_vault(
        &mut rotated_identity,
        old_identity.vault_id.clone(),
        next_epoch,
        new_key,
    )?;
    let database_result = (|| -> Result<()> {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        let transaction = connection.unchecked_transaction().map_err(error)?;
        let revoked_at = now();
        transaction
            .execute(
                "UPDATE device_authorizations SET revoked_at = ?2 WHERE device_id = ?1",
                params![device_id, revoked_at],
            )
            .map_err(error)?;
        let revocation_id = make_id();
        sync::enqueue_operation(
            &transaction,
            &old_identity,
            &revocation_id,
            sync::SyncOperation::DeviceRevocation(sync::DeviceRevocation {
                device_id: device_id.clone(),
                revoked_at,
            }),
        )?;
        let rotation_id = make_id();
        sync::enqueue_operation(
            &transaction,
            &old_identity,
            &rotation_id,
            sync::SyncOperation::VaultKeyRotation(sync::VaultKeyRotation {
                epoch: next_epoch,
                vault_key: URL_SAFE_NO_PAD.encode(new_key),
                rotated_at: now(),
            }),
        )?;
        transaction
            .execute(
                "UPDATE vaults SET key_epoch = ?2 WHERE id = ?1",
                params![old_identity.vault_id, next_epoch],
            )
            .map_err(error)?;
        transaction.commit().map_err(error)
    })();
    if let Err(message) = database_result {
        let _ = sync::persist_identity(&old_identity);
        return Err(message);
    }
    let mut live_identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    *live_identity = rotated_identity.clone();
    drop(live_identity);
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    sync_status(&connection, &rotated_identity)
}

#[tauri::command]
fn start_pairing(state: State<'_, AppState>) -> Result<PairingOffer> {
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?
        .clone();
    let relay_url = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        configured_relay(&connection)?
    }
    .ok_or_else(|| {
        "Papyrus Sync needs a relay URL in this build before devices can be paired.".to_string()
    })?;
    let session_id = make_id();
    let secret_bytes = sync::random_bytes(32);
    let secret = URL_SAFE_NO_PAD.encode(&secret_bytes);
    let expires_at = (Utc::now() + Duration::minutes(5)).to_rfc3339();
    let payload = PairingStartRequest {
        vault_id: identity.vault_id.clone(),
        session_id: session_id.clone(),
        secret_hash: sync::sha256_hex(secret.as_bytes()),
        expires_at: expires_at.clone(),
    };
    let _: serde_json::Value =
        RelayTransport::new(&relay_url)?.post(&identity, "/v1/pairing/start", &payload)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    connection.execute("INSERT OR REPLACE INTO pairing_sessions(id, secret_hash, expires_at, state, created_at) VALUES (?1, ?2, ?3, 'open', ?4)", params![session_id, payload.secret_hash, expires_at, now()]).map_err(error)?;
    let code = encode_pairing_code(&PairingCode {
        version: 1,
        relay_url,
        session_id,
        secret,
        expires_at: expires_at.clone(),
    })?;
    Ok(PairingOffer { code, expires_at })
}

#[tauri::command]
fn accept_pairing(code: String, state: State<'_, AppState>) -> Result<PairingProgress> {
    let pairing = decode_pairing_code(&code)?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?
        .clone();
    let payload = PairingHelloRequest {
        session_id: pairing.session_id.clone(),
        secret: pairing.secret.clone(),
        device_id: identity.device_id.clone(),
        display_name: identity.device_name.clone(),
        signing_key: URL_SAFE_NO_PAD.encode(identity.signing_public_key()),
        agreement_key: URL_SAFE_NO_PAD.encode(identity.agreement_public_key()),
    };
    let _: serde_json::Value =
        RelayTransport::new(&pairing.relay_url)?.post(&identity, "/v1/pairing/hello", &payload)?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    set_sync_state(&connection, "relay_url", &pairing.relay_url)?;
    set_sync_state(&connection, "pairing_session", &pairing.session_id)?;
    Ok(PairingProgress {
        ready: false,
        message: "Waiting for your other device to approve…".into(),
    })
}

#[tauri::command]
fn complete_pairing(code: String, state: State<'_, AppState>) -> Result<PairingProgress> {
    let pairing = decode_pairing_code(&code)?;
    let identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?
        .clone();
    {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        let local_state: Option<String> = connection
            .query_row(
                "SELECT state FROM pairing_sessions WHERE id = ?1",
                [&pairing.session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        if local_state.as_deref() == Some("complete") {
            return Ok(PairingProgress {
                ready: true,
                message: "Device paired".into(),
            });
        }
    }
    let claim: PairingClaimResponse = RelayTransport::new(&pairing.relay_url)?.post(
        &identity,
        "/v1/pairing/claim",
        &PairingClaimRequest {
            vault_id: identity.vault_id.clone(),
            session_id: pairing.session_id.clone(),
        },
    )?;
    if !claim.ready {
        return Ok(PairingProgress {
            ready: false,
            message: "Waiting for the new device to scan this code…".into(),
        });
    }
    let device_id = claim
        .device_id
        .ok_or_else(|| "The pairing claim is incomplete.".to_string())?;
    let display_name = claim
        .display_name
        .ok_or_else(|| "The pairing claim is incomplete.".to_string())?;
    let signing_text = claim
        .signing_key
        .ok_or_else(|| "The pairing claim is incomplete.".to_string())?;
    let agreement_text = claim
        .agreement_key
        .ok_or_else(|| "The pairing claim is incomplete.".to_string())?;
    let signing_key = URL_SAFE_NO_PAD
        .decode(&signing_text)
        .map_err(|_| "The new device signing key is invalid.".to_string())?;
    let agreement_key = URL_SAFE_NO_PAD
        .decode(&agreement_text)
        .map_err(|_| "The new device agreement key is invalid.".to_string())?;
    if signing_key.len() != 32 || agreement_key.len() != 32 {
        return Err("The new device keys are invalid.".into());
    }
    let authorized_at = now();
    {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        let transaction = connection.unchecked_transaction().map_err(error)?;
        transaction.execute("INSERT INTO devices(id, display_name, public_key, agreement_public_key, created_at, is_local) VALUES (?1, ?2, ?3, ?4, ?5, 0) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, public_key = excluded.public_key, agreement_public_key = excluded.agreement_public_key", params![device_id, display_name, signing_key, agreement_key, authorized_at]).map_err(error)?;
        transaction.execute("INSERT INTO device_authorizations(device_id, authorized_at, revoked_at) VALUES (?1, ?2, NULL) ON CONFLICT(device_id) DO UPDATE SET authorized_at = excluded.authorized_at, revoked_at = NULL", params![device_id, authorized_at]).map_err(error)?;
        let operation_id = make_id();
        sync::enqueue_operation(
            &transaction,
            &identity,
            &operation_id,
            sync::SyncOperation::DeviceAuthorization(sync::DeviceAuthorization {
                device_id: device_id.clone(),
                display_name: display_name.clone(),
                signing_public_key: signing_text.clone(),
                agreement_public_key: agreement_text.clone(),
                authorized_at: authorized_at.clone(),
            }),
        )?;
        transaction.commit().map_err(error)?;
    }
    let snapshot = {
        let connection = state
            .db
            .lock()
            .map_err(|_| "Notebook is busy".to_string())?;
        build_snapshot(&connection, &identity)?
    };
    let snapshot_json = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
    let mut compressor = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    compressor
        .write_all(&snapshot_json)
        .map_err(|error| error.to_string())?;
    let compressed = compressor.finish().map_err(|error| error.to_string())?;
    let sealed = sync::seal_pairing_payload(
        &identity,
        &agreement_key,
        pairing.secret.as_bytes(),
        &compressed,
    )?;
    let sealed_payload = serde_json::to_string(&sealed).map_err(|error| error.to_string())?;
    if sealed_payload.len() > 46 * 1024 * 1024 {
        return Err("This notebook is too large for a single pairing transfer. Export it first or remove large embedded images.".into());
    }
    let _: serde_json::Value = RelayTransport::new(&pairing.relay_url)?.post(
        &identity,
        "/v1/pairing/complete",
        &PairingCompleteRequest {
            session_id: pairing.session_id.clone(),
            device_id: device_id.clone(),
            sealed_payload,
        },
    )?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    connection
        .execute(
            "UPDATE pairing_sessions SET state = 'complete', peer_device_id = ?2 WHERE id = ?1",
            params![pairing.session_id, device_id],
        )
        .map_err(error)?;
    Ok(PairingProgress {
        ready: true,
        message: "Device paired".into(),
    })
}

#[tauri::command]
fn finish_pairing(code: String, state: State<'_, AppState>) -> Result<PairingProgress> {
    let pairing = decode_pairing_code(&code)?;
    let current_identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?
        .clone();
    let response: PairingFinishResponse = RelayTransport::new(&pairing.relay_url)?.post(
        &current_identity,
        "/v1/pairing/finish",
        &PairingFinishRequest {
            session_id: pairing.session_id,
            secret: pairing.secret.clone(),
            device_id: current_identity.device_id.clone(),
        },
    )?;
    if !response.ready {
        return Ok(PairingProgress {
            ready: false,
            message: "Waiting for approval on your other device…".into(),
        });
    }
    let sealed: sync::SealedPairingPayload = serde_json::from_str(
        &response
            .sealed_payload
            .ok_or_else(|| "The pairing snapshot is missing.".to_string())?,
    )
    .map_err(|_| "The pairing snapshot is invalid.".to_string())?;
    let compressed =
        sync::open_pairing_payload(&current_identity, &sealed, pairing.secret.as_bytes())?;
    let mut decoder = flate2::read::GzDecoder::new(compressed.as_slice());
    let mut snapshot_json = Vec::new();
    decoder
        .read_to_end(&mut snapshot_json)
        .map_err(|_| "The pairing snapshot is damaged.".to_string())?;
    let snapshot: NotebookSnapshot = serde_json::from_slice(&snapshot_json)
        .map_err(|_| "The pairing snapshot is invalid.".to_string())?;
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let mut identity = state
        .identity
        .lock()
        .map_err(|_| "Sync identity is busy".to_string())?;
    let merged = import_snapshot(&connection, &mut identity, snapshot, &pairing.relay_url)?;
    Ok(PairingProgress {
        ready: true,
        message: paired_message(merged),
    })
}

fn paired_message(merged: ReplayCounts) -> String {
    match merged.notes {
        0 => "Notebook paired and ready".into(),
        1 => "Notebook paired. 1 note from this device merged in.".into(),
        count => format!("Notebook paired. {count} notes from this device merged in."),
    }
}

#[tauri::command]
fn export_notebook(destination: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state
        .db
        .lock()
        .map_err(|_| "Notebook is busy".to_string())?;
    let mut statement = connection.prepare("SELECT n.id, n.title, n.body, n.category_id, c.name, n.created_at, n.updated_at, n.deleted_at, n.revision_id FROM notes n LEFT JOIN categories c ON c.id = n.category_id WHERE n.deleted_at IS NULL ORDER BY c.position, n.updated_at DESC").map_err(error)?;
    let notes = statement
        .query_map([], note_from_row)
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    let file = File::create(PathBuf::from(destination)).map_err(|error| error.to_string())?;
    let mut archive = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut used = HashSet::new();
    for note in notes {
        let folder = safe_component(
            note.category_name.as_deref().unwrap_or("Uncategorized"),
            "Uncategorized",
        );
        let title = safe_component(&note.title, "Untitled note");
        let mut candidate = format!("Notes/{folder}/{title}.md");
        let mut number = 2;
        while used.contains(&candidate) {
            candidate = format!("Notes/{folder}/{title} {number}.md");
            number += 1;
        }
        used.insert(candidate.clone());
        archive
            .start_file(candidate, options)
            .map_err(|error| error.to_string())?;
        let category = note.category_name.unwrap_or_default().replace('"', "\\\"");
        let frontmatter = format!(
            "---\nid: {}\ncreated_at: {}\nupdated_at: {}\ncategory: \"{}\"\n---\n\n",
            note.id, note.created_at, note.updated_at, category
        );
        archive
            .write_all(frontmatter.as_bytes())
            .map_err(|error| error.to_string())?;
        archive
            .write_all(note.body.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    archive.finish().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let connection = open_notebook(app.handle()).map_err(std::io::Error::other)?;
            let identity = sync::bootstrap_identity(&connection).map_err(std::io::Error::other)?;
            backfill_sync_history(&connection, &identity).map_err(std::io::Error::other)?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            app.manage(AppState {
                db: Mutex::new(connection),
                identity: Mutex::new(identity),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_database,
            list_categories,
            create_category,
            rename_category,
            move_category,
            delete_category,
            list_notes,
            get_note,
            get_note_conflict,
            resolve_note_conflict,
            save_note,
            move_note,
            trash_note,
            restore_note,
            delete_note_permanently,
            empty_trash,
            duplicate_note,
            export_notebook,
            embed_image,
            get_setting,
            set_setting,
            get_sync_status,
            sync_now,
            rename_sync_device,
            remove_sync_device,
            start_pairing,
            accept_pairing,
            complete_pairing,
            finish_pairing
        ])
        .run(tauri::generate_context!())
        .expect("error while running Papyrus");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identities() -> (sync::SyncIdentity, sync::SyncIdentity) {
        let key = [7u8; 32];
        (
            sync::test_identity("vault-test", "device-a", "Laptop", key),
            sync::test_identity("vault-test", "device-b", "iPhone", key),
        )
    }

    fn register(connection: &Connection, identity: &sync::SyncIdentity, local: bool) {
        connection
            .execute(
                "INSERT OR IGNORE INTO vaults(id, key_epoch, created_at) VALUES (?1, 1, ?2)",
                params![identity.vault_id, now()],
            )
            .unwrap();
        connection.execute(
            "INSERT OR REPLACE INTO devices(id, display_name, public_key, agreement_public_key, created_at, is_local) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![identity.device_id, identity.device_name, identity.signing_public_key(), identity.agreement_public_key(), now(), i64::from(local)],
        ).unwrap();
        connection.execute("INSERT OR REPLACE INTO device_authorizations(device_id, authorized_at, revoked_at) VALUES (?1, ?2, NULL)", params![identity.device_id, now()]).unwrap();
    }

    fn notebook() -> (Connection, sync::SyncIdentity, sync::SyncIdentity) {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();
        let (local, remote) = identities();
        register(&connection, &local, true);
        register(&connection, &remote, false);
        (connection, local, remote)
    }

    fn note_state(
        note_id: &str,
        revision_id: &str,
        parent: Option<&str>,
        body: &str,
    ) -> sync::NoteRevisionState {
        sync::NoteRevisionState {
            id: note_id.into(),
            title: markdown_title(body),
            body: body.into(),
            category_id: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: now(),
            deleted_at: None,
            purged_at: None,
            revision_id: revision_id.into(),
            parent_revision_id: parent.map(str::to_string),
        }
    }

    fn insert_local_note(
        connection: &Connection,
        identity: &sync::SyncIdentity,
        state: &sync::NoteRevisionState,
    ) {
        let note = Note {
            id: state.id.clone(),
            title: state.title.clone(),
            body: state.body.clone(),
            category_id: None,
            category_name: None,
            created_at: state.created_at.clone(),
            updated_at: state.updated_at.clone(),
            deleted_at: state.deleted_at.clone(),
            revision_id: state.revision_id.clone(),
        };
        connection.execute("INSERT OR REPLACE INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)", params![note.id, note.title, note.body, note.created_at, note.updated_at, note.deleted_at, note.revision_id]).unwrap();
        record_revision(
            connection,
            identity,
            &note,
            state.parent_revision_id.clone(),
            state.purged_at.clone(),
        )
        .unwrap();
        reindex_note(connection, &note.id).unwrap();
    }

    // A snapshot for a vault this device does not belong to yet, authorizing the
    // local device and one peer — what a host seals during pairing.
    fn host_snapshot(local: &sync::SyncIdentity, peer: &sync::SyncIdentity) -> NotebookSnapshot {
        let device = |identity: &sync::SyncIdentity| SnapshotDevice {
            id: identity.device_id.clone(),
            display_name: identity.device_name.clone(),
            signing_key: URL_SAFE_NO_PAD.encode(identity.signing_public_key()),
            agreement_key: URL_SAFE_NO_PAD.encode(identity.agreement_public_key()),
            created_at: now(),
            authorized_at: now(),
            revoked_at: None,
            last_seen_at: None,
        };
        NotebookSnapshot {
            version: 1,
            vault_id: "vault-host".into(),
            vault_key_epoch: 1,
            vault_key: URL_SAFE_NO_PAD.encode([9u8; 32]),
            notes: vec![Note {
                id: "host-note".into(),
                title: "Host".into(),
                body: "# Host\n\nlived in the vault first".into(),
                category_id: None,
                category_name: None,
                created_at: now(),
                updated_at: now(),
                deleted_at: None,
                revision_id: "host-rev".into(),
            }],
            categories: vec![SnapshotCategory {
                id: "host-cat".into(),
                name: "Personal".into(),
                position: 0,
                created_at: now(),
                updated_at: now(),
                deleted_at: None,
                revision_id: "host-cat-rev".into(),
            }],
            note_revisions: vec![SnapshotNoteRevision {
                id: "host-rev".into(),
                note_id: "host-note".into(),
                parent_revision_id: None,
                device_id: peer.device_id.clone(),
                created_at: now(),
                note_created_at: now(),
                updated_at: now(),
                content_hash: sync::content_hash("Host", "# Host\n\nlived in the vault first", None, None),
                title: "Host".into(),
                body: "# Host\n\nlived in the vault first".into(),
                category_id: None,
                deleted_at: None,
                purged_at: None,
            }],
            category_revisions: vec![],
            devices: vec![device(local), device(peer)],
            heads: vec![SnapshotHead {
                entity_type: "note".into(),
                entity_id: "host-note".into(),
                revision_id: "host-rev".into(),
            }],
            tombstones: vec![],
            conflicts: vec![],
        }
    }

    #[test]
    fn pairing_merges_this_devices_notebook_into_the_adopted_vault() {
        let (connection, mut local, peer) = notebook();
        insert_local_note(
            &connection,
            &local,
            &note_state("local-note", "local-rev", None, "# Mine\n\nwritten before pairing"),
        );
        connection.execute(
            "INSERT INTO categories(id, name, position, created_at, updated_at, deleted_at, revision_id)
             VALUES ('local-cat', 'Personal', 0, ?1, ?1, NULL, 'local-cat-rev')",
            params![now()],
        ).unwrap();

        let snapshot = host_snapshot(&local, &peer);
        let merged =
            import_snapshot(&connection, &mut local, snapshot, "https://relay.example").unwrap();

        assert_eq!(merged.notes, 1);
        assert_eq!(merged.categories, 1);
        assert_eq!(local.vault_id, "vault-host");

        // Both notebooks are present: nothing was replaced.
        let mut bodies: Vec<String> = connection
            .prepare("SELECT body FROM notes ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        bodies.sort();
        assert_eq!(bodies.len(), 2);
        assert!(bodies.iter().any(|body| body.contains("written before pairing")));
        assert!(bodies.iter().any(|body| body.contains("lived in the vault first")));

        // Same-named categories both survive, and the carried one is repositioned
        // after the adopted vault's own.
        let position: i64 = connection
            .query_row("SELECT position FROM categories WHERE id = 'local-cat'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(position, 1);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM categories WHERE name = 'Personal'", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );

        // The carried note is replayed as a root revision — a peer that never saw
        // its old ancestry can still apply it — and is queued for that peer.
        let parent: Option<String> = connection
            .query_row(
                "SELECT r.parent_revision_id FROM note_revisions r
                 JOIN entity_heads h ON h.revision_id = r.id
                 WHERE h.entity_type = 'note' AND h.entity_id = 'local-note'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent, None);
        let queued: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_outbox WHERE state = 'pending'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(queued, 2);

        // ...and the pre-pairing notebook is archived either way.
        let archived: String = connection
            .query_row("SELECT snapshot FROM notebook_archives", [], |row| row.get(0))
            .unwrap();
        assert!(archived.contains("written before pairing"));
        assert!(!archived.contains("lived in the vault first"));
    }

    #[test]
    fn existing_v1_notebook_migrates_without_losing_notes() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
             INSERT INTO schema_migrations VALUES (1, '2026-01-01');
             CREATE TABLE categories(id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
             CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', category_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, revision_id TEXT NOT NULL, FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL);
             CREATE INDEX notes_recency_idx ON notes(updated_at DESC); CREATE INDEX notes_deleted_idx ON notes(deleted_at); CREATE INDEX notes_category_idx ON notes(category_id);
             CREATE TABLE note_revisions(id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_revision_id TEXT, device_id TEXT, updated_at TEXT NOT NULL, content_hash TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, category_id TEXT, deleted_at TEXT);
             CREATE TABLE deleted_items(item_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL, purge_after TEXT NOT NULL);
             CREATE TABLE devices(id TEXT PRIMARY KEY, display_name TEXT, public_key BLOB, created_at TEXT NOT NULL);
             CREATE TABLE device_authorizations(device_id TEXT PRIMARY KEY, authorized_at TEXT NOT NULL, revoked_at TEXT);
             CREATE TABLE sync_queue(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE sync_receipts(id TEXT PRIMARY KEY, package_id TEXT NOT NULL, received_at TEXT NOT NULL);
             CREATE TABLE sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title, body, category_name);
             INSERT INTO categories VALUES ('cat', 'Work', 0, '2026-01-01', '2026-01-01');
             INSERT INTO notes VALUES ('note', 'Plan', '# Plan', 'cat', '2026-01-01', '2026-01-01', NULL, 'rev');"
        ).unwrap();
        migrate(&connection).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT body FROM notes WHERE id = 'note'", [], |row| row
                    .get::<_, String>(
                    0
                ))
                .unwrap(),
            "# Plan"
        );
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            4
        );
        assert!(connection.prepare("SELECT * FROM sync_outbox").is_ok());
    }

    #[test]
    fn encrypted_operation_round_trips_between_authorized_devices() {
        let (sender, receiver) = identities();
        let operation =
            sync::SyncOperation::NoteRevision(note_state("n", "r", None, "# Secret\n\nhello"));
        let envelope = sync::encrypt_operation(&sender, operation).unwrap();
        let decrypted =
            sync::decrypt_operation(&receiver, &envelope, &sender.signing_public_key()).unwrap();
        match decrypted {
            sync::SyncOperation::NoteRevision(note) => assert_eq!(note.body, "# Secret\n\nhello"),
            _ => panic!("wrong operation"),
        }
    }

    #[test]
    fn tampered_encrypted_package_is_rejected() {
        let (sender, receiver) = identities();
        let mut envelope = sync::encrypt_operation(
            &sender,
            sync::SyncOperation::NoteRevision(note_state("n", "r", None, "secret")),
        )
        .unwrap();
        envelope.ciphertext.push('A');
        assert!(
            sync::decrypt_operation(&receiver, &envelope, &sender.signing_public_key()).is_err()
        );
    }

    #[test]
    fn pairing_payload_requires_the_matching_device_and_secret() {
        let (host, guest) = identities();
        let sealed = sync::seal_pairing_payload(
            &host,
            &guest.agreement_public_key(),
            b"one-time-secret",
            b"snapshot",
        )
        .unwrap();
        assert_eq!(
            sync::open_pairing_payload(&guest, &sealed, b"one-time-secret").unwrap(),
            b"snapshot"
        );
        assert!(sync::open_pairing_payload(&guest, &sealed, b"wrong-secret").is_err());
    }

    #[test]
    fn duplicate_delivery_is_idempotent() {
        let (connection, _local, remote) = notebook();
        let operation =
            sync::SyncOperation::NoteRevision(note_state("note", "remote-1", None, "# Remote"));
        let envelope = sync::encrypt_operation(&remote, operation.clone()).unwrap();
        apply_remote_operation(&connection, &envelope, operation.clone()).unwrap();
        apply_remote_operation(&connection, &envelope, operation).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM note_revisions WHERE id = 'remote-1'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_receipts WHERE package_id = ?1",
                    [&envelope.package_id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn two_separate_device_databases_exchange_an_encrypted_note() {
        let (laptop, phone) = identities();
        let laptop_db = Connection::open_in_memory().unwrap();
        let phone_db = Connection::open_in_memory().unwrap();
        migrate(&laptop_db).unwrap();
        migrate(&phone_db).unwrap();
        register(&laptop_db, &laptop, true);
        register(&laptop_db, &phone, false);
        register(&phone_db, &phone, true);
        register(&phone_db, &laptop, false);
        insert_local_note(
            &laptop_db,
            &laptop,
            &note_state("shared", "laptop-rev", None, "# Shared\n\nEncrypted hello"),
        );
        let outgoing = pending_outbox(&laptop_db).unwrap();
        assert_eq!(outgoing.len(), 1);
        let operation =
            sync::decrypt_operation(&phone, &outgoing[0].envelope, &laptop.signing_public_key())
                .unwrap();
        apply_remote_operation(&phone_db, &outgoing[0].envelope, operation).unwrap();
        assert_eq!(
            find_note(&phone_db, "shared").unwrap().unwrap().body,
            "# Shared\n\nEncrypted hello"
        );
    }

    #[test]
    fn out_of_order_child_waits_for_its_parent() {
        let (connection, _local, remote) = notebook();
        let child = note_state("note", "child", Some("missing-parent"), "# Child");
        assert!(apply_remote_note(&connection, &child, &remote.device_id)
            .unwrap_err()
            .contains("parent"));
        assert!(!note_revision_exists(&connection, "child").unwrap());
    }

    #[test]
    fn offline_edits_create_a_conflict_and_keep_both_resolves_it() {
        let (connection, local, remote) = notebook();
        let base = note_state("note", "base", None, "# Plan\n\nbase");
        insert_local_note(&connection, &local, &base);
        let local_edit = note_state("note", "local-edit", Some("base"), "# Plan\n\nlaptop edit");
        insert_local_note(&connection, &local, &local_edit);
        let remote_edit = note_state("note", "remote-edit", Some("base"), "# Plan\n\nphone edit");
        apply_remote_note(&connection, &remote_edit, &remote.device_id).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_conflicts WHERE status = 'open'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        let resolved = resolve_note_conflict_in(&connection, &local, "note", "both").unwrap();
        assert!(resolved.body.contains("laptop edit"));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sync_conflicts WHERE status = 'open'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM notes WHERE body LIKE '%phone edit%'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                >= 1
        );
    }

    #[test]
    fn permanent_deletion_cannot_be_resurrected_by_an_offline_device() {
        let (connection, local, remote) = notebook();
        let base = note_state("note", "base", None, "# Durable");
        insert_local_note(&connection, &local, &base);
        let mut deletion = note_state("note", "deleted", Some("base"), "# Durable");
        deletion.deleted_at = Some(now());
        deletion.purged_at = Some(now());
        apply_remote_note(&connection, &deletion, &remote.device_id).unwrap();
        assert!(find_note(&connection, "note").unwrap().is_none());
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM tombstones WHERE entity_id = 'note' AND purged_at IS NOT NULL", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        let stale = note_state("note", "stale", Some("base"), "# Durable\n\nstale edit");
        apply_remote_note(&connection, &stale, &local.device_id).unwrap();
        assert!(find_note(&connection, "note").unwrap().is_none());
    }

    #[test]
    fn concurrent_category_renames_preserve_a_conflict_record() {
        let (connection, local, remote) = notebook();
        let timestamp = now();
        let category = Category {
            id: "cat".into(),
            name: "Work".into(),
            position: 0,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        };
        connection.execute("INSERT INTO categories(id, name, position, created_at, updated_at, deleted_at, revision_id) VALUES ('cat', 'Work', 0, ?1, ?1, NULL, '')", [&timestamp]).unwrap();
        record_category_revision(
            &connection,
            &local,
            &category,
            None,
            None,
            "base-cat".into(),
        )
        .unwrap();
        let mut laptop = category.clone();
        laptop.name = "Laptop Work".into();
        laptop.updated_at = now();
        record_category_revision(
            &connection,
            &local,
            &laptop,
            Some("base-cat".into()),
            None,
            "local-cat".into(),
        )
        .unwrap();
        let phone = sync::CategoryRevisionState {
            id: "cat".into(),
            name: "Phone Work".into(),
            position: 0,
            created_at: timestamp,
            updated_at: now(),
            deleted_at: None,
            revision_id: "remote-cat".into(),
            parent_revision_id: Some("base-cat".into()),
        };
        apply_remote_category(&connection, &phone, &remote.device_id).unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM sync_conflicts WHERE entity_type = 'category' AND status = 'open'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert!(category_revision_exists(&connection, "remote-cat").unwrap());
    }

    #[test]
    fn pending_outbox_survives_an_application_restart() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.sqlite3");
        let local = {
            let connection = Connection::open(&path).unwrap();
            migrate(&connection).unwrap();
            let (local, remote) = identities();
            register(&connection, &local, true);
            register(&connection, &remote, false);
            insert_local_note(
                &connection,
                &local,
                &note_state("note", "rev", None, "# Restart"),
            );
            local
        };
        let reopened = Connection::open(&path).unwrap();
        migrate(&reopened).unwrap();
        assert_eq!(pending_outbox(&reopened).unwrap().len(), 1);
        assert_eq!(local.device_id, "device-a");
    }

    #[test]
    fn failed_snapshot_style_transaction_leaves_the_old_notebook_intact() {
        let (connection, local, _) = notebook();
        insert_local_note(
            &connection,
            &local,
            &note_state("original", "original-rev", None, "# Original"),
        );
        let attempt = (|| -> Result<()> {
            let transaction = connection.unchecked_transaction().map_err(error)?;
            transaction
                .execute("DELETE FROM notes", [])
                .map_err(error)?;
            transaction.execute("INSERT INTO notes(id, title, body, created_at, updated_at, revision_id) VALUES ('duplicate', '', '', 'x', 'x', 'r')", []).map_err(error)?;
            transaction.execute("INSERT INTO notes(id, title, body, created_at, updated_at, revision_id) VALUES ('duplicate', '', '', 'x', 'x', 'r2')", []).map_err(error)?;
            transaction.commit().map_err(error)
        })();
        assert!(attempt.is_err());
        assert!(find_note(&connection, "original").unwrap().is_some());
    }

    #[test]
    fn revoked_sender_is_excluded_from_authorized_key_lookup() {
        let (connection, _local, remote) = notebook();
        connection
            .execute(
                "UPDATE device_authorizations SET revoked_at = ?2 WHERE device_id = ?1",
                params![remote.device_id, now()],
            )
            .unwrap();
        let key = connection.query_row("SELECT d.public_key FROM devices d JOIN device_authorizations a ON a.device_id = d.id WHERE d.id = ?1 AND a.revoked_at IS NULL", [&remote.device_id], |row| row.get::<_, Vec<u8>>(0)).optional().unwrap();
        assert!(key.is_none());
    }

    #[test]
    fn rust_transport_proof_talks_to_the_local_worker_when_enabled() {
        if std::env::var("PAPYRUS_RELAY_E2E").as_deref() != Ok("1") {
            return;
        }
        let identity = sync::test_identity(&make_id(), &make_id(), "E2E laptop", [11u8; 32]);
        let transport = RelayTransport::new("http://127.0.0.1:8787").unwrap();
        let session_id = make_id();
        let secret = URL_SAFE_NO_PAD.encode(sync::random_bytes(32));
        let _: serde_json::Value = transport
            .post(
                &identity,
                "/v1/pairing/start",
                &PairingStartRequest {
                    vault_id: identity.vault_id.clone(),
                    session_id,
                    secret_hash: sync::sha256_hex(secret.as_bytes()),
                    expires_at: (Utc::now() + Duration::minutes(4)).to_rfc3339(),
                },
            )
            .unwrap();
        let inbox = transport
            .fetch(
                &identity,
                &FetchPackages {
                    vault_id: identity.vault_id.clone(),
                    device_id: identity.device_id.clone(),
                    limit: 4,
                },
            )
            .unwrap();
        assert!(inbox.packages.is_empty());
    }
}
