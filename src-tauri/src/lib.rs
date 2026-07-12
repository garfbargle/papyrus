use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::{self, File}, io::Write, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

type Result<T> = std::result::Result<T, String>;

struct AppState {
    db: Mutex<Connection>,
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

fn error(error: rusqlite::Error) -> String { error.to_string() }
fn now() -> String { Utc::now().to_rfc3339() }
fn make_id() -> String { Uuid::new_v4().to_string() }

fn open_notebook(app: &AppHandle) -> Result<Connection> {
    let path = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    let connection = Connection::open(path.join("papyrus.sqlite3")).map_err(error)?;
    migrate(&connection)?;
    cleanup_expired_trash(&connection)?;
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
    ).map_err(error)
}

fn cleanup_expired_trash(connection: &Connection) -> Result<()> {
    let cutoff = (Utc::now() - Duration::days(30)).to_rfc3339();
    connection.execute("DELETE FROM notes_fts WHERE id IN (SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?1)", [&cutoff]).map_err(error)?;
    connection.execute("DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?1", [&cutoff]).map_err(error)?;
    connection.execute("DELETE FROM deleted_items WHERE purge_after < ?1", [&now()]).map_err(error)?;
    Ok(())
}

fn note_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?, title: row.get(1)?, body: row.get(2)?, category_id: row.get(3)?, category_name: row.get(4)?,
        created_at: row.get(5)?, updated_at: row.get(6)?, deleted_at: row.get(7)?, revision_id: row.get(8)?,
    })
}

fn markdown_title(body: &str) -> String {
    let Some(line) = body.lines().find(|line| !line.trim().is_empty()) else { return String::new(); };
    let mut text = line.trim();
    text = text.trim_start_matches('#').trim_start();
    text = text.strip_prefix('>').unwrap_or(text).trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = text.strip_prefix(marker) { text = rest; break; }
    }
    if let Some((prefix, rest)) = text.split_once(". ") {
        if !prefix.is_empty() && prefix.chars().all(|character| character.is_ascii_digit()) { text = rest; }
    }
    text = text.strip_prefix("[ ] ").or_else(|| text.strip_prefix("[x] ")).or_else(|| text.strip_prefix("[X] ")).unwrap_or(text);
    text.replace(['#', '*', '`', '>', '|', '_', '~'], "").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect()
}

fn compact_preview(body: &str) -> String {
    let mut skipped_title = false;
    body.lines()
        .filter(|line| {
            if !skipped_title && !line.trim().is_empty() { skipped_title = true; return false; }
            skipped_title
        })
        .filter(|line| !line.trim_start().starts_with("```"))
        .map(|line| line.replace("- [ ]", "").replace("- [x]", "").replace("- [X]", ""))
        .collect::<Vec<_>>().join(" ")
        .replace(['#', '*', '`', '>', '|'], "")
        .split_whitespace().collect::<Vec<_>>().join(" ")
        .chars().take(155).collect()
}

fn fts_query(value: &str) -> String {
    value.split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "")))
        .collect::<Vec<_>>().join(" AND ")
}

fn reindex_note(connection: &Connection, id: &str) -> Result<()> {
    let source: Option<(String, String, Option<String>)> = connection.query_row(
        "SELECT n.title, n.body, c.name FROM notes n LEFT JOIN categories c ON c.id = n.category_id WHERE n.id = ?1",
        [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(error)?;
    connection.execute("DELETE FROM notes_fts WHERE id = ?1", [id]).map_err(error)?;
    if let Some((title, body, category_name)) = source {
        connection.execute("INSERT INTO notes_fts(id, title, body, category_name) VALUES (?1, ?2, ?3, ?4)", params![id, title, body, category_name.unwrap_or_default()]).map_err(error)?;
    }
    Ok(())
}

fn record_revision(connection: &Connection, note: &Note, parent_revision_id: Option<String>) -> Result<()> {
    let mut hash = Sha256::new();
    hash.update(note.title.as_bytes()); hash.update([0]); hash.update(note.body.as_bytes()); hash.update([0]);
    hash.update(note.category_id.as_deref().unwrap_or_default().as_bytes()); hash.update([0]);
    hash.update(note.deleted_at.as_deref().unwrap_or_default().as_bytes());
    let digest = format!("{:x}", hash.finalize());
    connection.execute(
        "INSERT INTO note_revisions(id, note_id, parent_revision_id, device_id, updated_at, content_hash, title, body, category_id, deleted_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![note.revision_id, note.id, parent_revision_id, note.updated_at, digest, note.title, note.body, note.category_id, note.deleted_at],
    ).map_err(error)?;
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
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    cleanup_expired_trash(&connection)
}

#[tauri::command]
fn list_categories(state: State<'_, AppState>) -> Result<Vec<Category>> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let mut statement = connection.prepare("SELECT id, name, position, created_at, updated_at FROM categories ORDER BY position, name COLLATE NOCASE").map_err(error)?;
    let categories = statement.query_map([], |row| Ok(Category { id: row.get(0)?, name: row.get(1)?, position: row.get(2)?, created_at: row.get(3)?, updated_at: row.get(4)? }))
        .map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    Ok(categories)
}

#[tauri::command]
fn create_category(name: String, state: State<'_, AppState>) -> Result<Category> {
    let name = name.trim(); if name.is_empty() { return Err("A category needs a name.".into()); }
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let position: i64 = connection.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM categories", [], |row| row.get(0)).map_err(error)?;
    let category = Category { id: make_id(), name: name.to_owned(), position, created_at: now(), updated_at: now() };
    connection.execute("INSERT INTO categories(id, name, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![category.id, category.name, category.position, category.created_at, category.updated_at]).map_err(|err| if err.to_string().contains("UNIQUE") { "That category already exists.".to_string() } else { error(err) })?;
    Ok(category)
}

#[tauri::command]
fn list_notes(filter: String, search: String, state: State<'_, AppState>) -> Result<Vec<NoteListItem>> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let query = fts_query(&search);
    let mut sql = "SELECT n.id, n.title, n.body, n.category_id, c.name, n.created_at, n.updated_at, n.deleted_at, n.revision_id FROM notes n LEFT JOIN categories c ON c.id = n.category_id".to_string();
    let mut clauses: Vec<&str> = Vec::new();
    if !query.is_empty() { sql.push_str(" JOIN notes_fts fts ON fts.id = n.id"); clauses.push("fts MATCH ?1"); }
    if filter == "trash" { clauses.push("n.deleted_at IS NOT NULL"); }
    else { clauses.push("n.deleted_at IS NULL"); if filter != "all" { clauses.push(if query.is_empty() { "n.category_id = ?1" } else { "n.category_id = ?2" }); } }
    sql.push_str(" WHERE "); sql.push_str(&clauses.join(" AND ")); sql.push_str(" ORDER BY n.updated_at DESC");
    let mut statement = connection.prepare(&sql).map_err(error)?;
    let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<NoteListItem> { let body: String = row.get(2)?; let stored_title: String = row.get(1)?; let derived_title = markdown_title(&body); Ok(NoteListItem { id: row.get(0)?, title: if derived_title.is_empty() { stored_title } else { derived_title }, preview: compact_preview(&body), category_id: row.get(3)?, category_name: row.get(4)?, created_at: row.get(5)?, updated_at: row.get(6)?, deleted_at: row.get(7)?, revision_id: row.get(8)? }) };
    let rows = if query.is_empty() && filter != "all" && filter != "trash" { statement.query_map([filter], read) } else if !query.is_empty() && filter != "all" && filter != "trash" { statement.query_map(params![query, filter], read) } else if !query.is_empty() { statement.query_map([query], read) } else { statement.query_map([], read) }.map_err(error)?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(error)
}

#[tauri::command]
fn get_note(id: String, state: State<'_, AppState>) -> Result<Option<Note>> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    find_note(&connection, &id)
}

#[tauri::command]
fn save_note(note: NoteInput, state: State<'_, AppState>) -> Result<Note> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let previous = find_note(&connection, &note.id)?;
    let timestamp = now(); let revision_id = make_id();
    let title = markdown_title(&note.body);
    let saved = Note { id: note.id, title, body: note.body, category_id: note.category_id, category_name: None, created_at: previous.as_ref().map(|item| item.created_at.clone()).unwrap_or_else(|| timestamp.clone()), updated_at: timestamp, deleted_at: previous.as_ref().and_then(|item| item.deleted_at.clone()), revision_id };
    if previous.is_some() {
        connection.execute("UPDATE notes SET title = ?2, body = ?3, category_id = ?4, updated_at = ?5, revision_id = ?6 WHERE id = ?1", params![saved.id, saved.title, saved.body, saved.category_id, saved.updated_at, saved.revision_id]).map_err(error)?;
    } else {
        connection.execute("INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)", params![saved.id, saved.title, saved.body, saved.category_id, saved.created_at, saved.updated_at, saved.revision_id]).map_err(error)?;
    }
    record_revision(&connection, &saved, previous.map(|item| item.revision_id))?; reindex_note(&connection, &saved.id)?;
    find_note(&connection, &saved.id)?.ok_or_else(|| "Saved note could not be loaded.".to_string())
}

#[tauri::command]
fn move_note(id: String, category_id: Option<String>, state: State<'_, AppState>) -> Result<()> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let Some(previous) = find_note(&connection, &id)? else { return Ok(()); };
    let mut next = previous.clone(); next.category_id = category_id; next.updated_at = now(); next.revision_id = make_id();
    connection.execute("UPDATE notes SET category_id = ?2, updated_at = ?3, revision_id = ?4 WHERE id = ?1", params![id, next.category_id, next.updated_at, next.revision_id]).map_err(error)?;
    record_revision(&connection, &next, Some(previous.revision_id))?; reindex_note(&connection, &id)
}

#[tauri::command]
fn trash_note(id: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let Some(previous) = find_note(&connection, &id)? else { return Ok(()); };
    let mut next = previous.clone(); next.deleted_at = Some(now()); next.updated_at = now(); next.revision_id = make_id();
    connection.execute("UPDATE notes SET deleted_at = ?2, updated_at = ?3, revision_id = ?4 WHERE id = ?1", params![id, next.deleted_at, next.updated_at, next.revision_id]).map_err(error)?;
    connection.execute("INSERT OR REPLACE INTO deleted_items(item_id, deleted_at, purge_after) VALUES (?1, ?2, ?3)", params![id, next.deleted_at, (Utc::now() + Duration::days(30)).to_rfc3339()]).map_err(error)?;
    record_revision(&connection, &next, Some(previous.revision_id))?; reindex_note(&connection, &id)
}

#[tauri::command]
fn restore_note(id: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let Some(previous) = find_note(&connection, &id)? else { return Ok(()); };
    let mut next = previous.clone(); next.deleted_at = None; next.updated_at = now(); next.revision_id = make_id();
    connection.execute("UPDATE notes SET deleted_at = NULL, updated_at = ?2, revision_id = ?3 WHERE id = ?1", params![id, next.updated_at, next.revision_id]).map_err(error)?;
    connection.execute("DELETE FROM deleted_items WHERE item_id = ?1", [&id]).map_err(error)?;
    record_revision(&connection, &next, Some(previous.revision_id))?; reindex_note(&connection, &id)
}

#[tauri::command]
fn delete_note_permanently(id: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    connection.execute("DELETE FROM notes_fts WHERE id = ?1", [&id]).map_err(error)?;
    connection.execute("DELETE FROM notes WHERE id = ?1", [&id]).map_err(error)?;
    connection.execute("DELETE FROM deleted_items WHERE item_id = ?1", [&id]).map_err(error)?;
    Ok(())
}

#[tauri::command]
fn empty_trash(state: State<'_, AppState>) -> Result<()> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    connection.execute("DELETE FROM notes_fts WHERE id IN (SELECT id FROM notes WHERE deleted_at IS NOT NULL)", []).map_err(error)?;
    connection.execute("DELETE FROM notes WHERE deleted_at IS NOT NULL", []).map_err(error)?;
    connection.execute("DELETE FROM deleted_items", []).map_err(error)?;
    Ok(())
}

#[tauri::command]
fn duplicate_note(id: String, state: State<'_, AppState>) -> Result<Note> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let source = find_note(&connection, &id)?.ok_or_else(|| "Note not found.".to_string())?;
    let timestamp = now(); let copy = Note { id: make_id(), title: markdown_title(&source.body), body: source.body, category_id: source.category_id, category_name: None, created_at: timestamp.clone(), updated_at: timestamp, deleted_at: None, revision_id: make_id() };
    connection.execute("INSERT INTO notes(id, title, body, category_id, created_at, updated_at, deleted_at, revision_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)", params![copy.id, copy.title, copy.body, copy.category_id, copy.created_at, copy.updated_at, copy.revision_id]).map_err(error)?;
    record_revision(&connection, &copy, None)?; reindex_note(&connection, &copy.id)?;
    find_note(&connection, &copy.id)?.ok_or_else(|| "Duplicate could not be loaded.".to_string())
}

fn safe_component(input: &str, fallback: &str) -> String {
    let cleaned = input.chars().map(|character| if character.is_ascii_alphanumeric() || character == ' ' || character == '-' || character == '_' { character } else { ' ' }).collect::<String>();
    let compact = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() { fallback.into() } else { compact.chars().take(90).collect() }
}

#[tauri::command]
fn embed_image(path: String) -> Result<String> {
    let source = PathBuf::from(&path);
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp",
        _ => return Err("Choose a PNG, JPEG, GIF, or WebP image.".into()),
    };
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    const MAX_INLINE_IMAGE_SIZE: usize = 4 * 1024 * 1024;
    if bytes.len() > MAX_INLINE_IMAGE_SIZE { return Err("Choose an image smaller than 4 MB for inline use.".into()); }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
fn get_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    connection.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0)).optional().map_err(error)
}

#[tauri::command]
fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    connection.execute("INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(error)?;
    Ok(())
}

#[tauri::command]
fn export_notebook(destination: String, state: State<'_, AppState>) -> Result<()> {
    let connection = state.db.lock().map_err(|_| "Notebook is busy".to_string())?;
    let mut statement = connection.prepare("SELECT n.id, n.title, n.body, n.category_id, c.name, n.created_at, n.updated_at, n.deleted_at, n.revision_id FROM notes n LEFT JOIN categories c ON c.id = n.category_id WHERE n.deleted_at IS NULL ORDER BY c.position, n.updated_at DESC").map_err(error)?;
    let notes = statement.query_map([], note_from_row).map_err(error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(error)?;
    let file = File::create(PathBuf::from(destination)).map_err(|error| error.to_string())?;
    let mut archive = ZipWriter::new(file); let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated); let mut used = HashSet::new();
    for note in notes {
        let folder = safe_component(note.category_name.as_deref().unwrap_or("Uncategorized"), "Uncategorized");
        let title = safe_component(&note.title, "Untitled note"); let mut candidate = format!("Notes/{folder}/{title}.md"); let mut number = 2;
        while used.contains(&candidate) { candidate = format!("Notes/{folder}/{title} {number}.md"); number += 1; }
        used.insert(candidate.clone()); archive.start_file(candidate, options).map_err(|error| error.to_string())?;
        let category = note.category_name.unwrap_or_default().replace('"', "\\\"");
        let frontmatter = format!("---\nid: {}\ncreated_at: {}\nupdated_at: {}\ncategory: \"{}\"\n---\n\n", note.id, note.created_at, note.updated_at, category);
        archive.write_all(frontmatter.as_bytes()).map_err(|error| error.to_string())?; archive.write_all(note.body.as_bytes()).map_err(|error| error.to_string())?;
    }
    archive.finish().map_err(|error| error.to_string())?; Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let connection = open_notebook(app.handle()).map_err(std::io::Error::other)?;
            app.manage(AppState { db: Mutex::new(connection) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initialize_database, list_categories, create_category, list_notes, get_note, save_note, move_note,
            trash_note, restore_note, delete_note_permanently, empty_trash, duplicate_note, export_notebook, embed_image,
            get_setting, set_setting
        ])
        .run(tauri::generate_context!())
        .expect("error while running Papyrus");
}
