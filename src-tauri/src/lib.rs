use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::RwLock;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{WebviewWindow, WebviewWindowBuilder},
    AppHandle, Emitter, Manager, State, WebviewUrl,
};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState as GsShortcutState,
};

// ─── Global shortcut roles ───
// Two configurable global shortcuts. The Rust handler dispatches by comparing
// the incoming Shortcut to the values stored in AppState (NOT by string match,
// which would break the moment a user picked something other than N/M).
const GS_ROLE_CAPTURE: &str = "capture";
const GS_ROLE_TOGGLE: &str = "toggle";

fn default_capture_shortcut() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::META | Modifiers::ALT | Modifiers::SHIFT),
        Code::KeyN,
    )
}

fn default_toggle_shortcut() -> Shortcut {
    Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::META | Modifiers::ALT | Modifiers::SHIFT),
        Code::KeyM,
    )
}

// ─── Paths ───
// Notes live under iCloud at Raynote/Spaces/<space-id>/*.md. Each space has
// its own .trash subfolder. Assets are shared across spaces under
// Raynote/assets/ so cross-space asset links keep resolving.
//
// The "default" space ID is reserved for the space that holds notes from
// before the spaces feature was introduced (see migrate_legacy_layout()).

const DEFAULT_SPACE_ID: &str = "default";

fn raynote_root_dir() -> PathBuf {
    let home = dirs_next::home_dir().expect("Could not find home directory");
    let dir = home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs")
        .join("Raynote");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create notes directory in iCloud");
    }
    dir
}

fn sanitize_space_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        DEFAULT_SPACE_ID.to_string()
    } else {
        cleaned
    }
}

fn spaces_root_dir() -> PathBuf {
    let dir = raynote_root_dir().join("Spaces");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create Spaces directory");
    }
    dir
}

fn space_notes_dir(space_id: &str) -> PathBuf {
    let safe = sanitize_space_id(space_id);
    let dir = spaces_root_dir().join(safe);
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create space notes directory");
    }
    dir
}

fn space_trash_dir(space_id: &str) -> PathBuf {
    let dir = space_notes_dir(space_id).join(".trash");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create trash directory");
    }
    dir
}

fn assets_dir() -> PathBuf {
    let dir = raynote_root_dir().join("assets");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create assets directory");
    }
    dir
}

fn cache_root_dir() -> PathBuf {
    let base = dirs_next::cache_dir()
        .or_else(|| dirs_next::home_dir().map(|h| h.join("Library").join("Caches")))
        .expect("Could not find cache directory");
    let dir = base.join("Raynote");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create cache directory");
    }
    dir
}

fn preview_cache_dir() -> PathBuf {
    let dir = cache_root_dir().join("preview-cache");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create preview cache directory");
    }
    dir
}

fn notes_meta_cache_path(space_id: &str) -> PathBuf {
    cache_root_dir().join(format!(
        "notes-meta-cache-{}.json",
        sanitize_space_id(space_id)
    ))
}

fn legacy_notes_meta_cache_path() -> PathBuf {
    cache_root_dir().join("notes-meta-cache.json")
}

fn safe_cache_part(raw: &str) -> String {
    raw.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn preview_cache_path(space: &str, id: &str, content_hash: &str) -> PathBuf {
    let space = safe_cache_part(space);
    let id = safe_cache_part(id);
    let content_hash = safe_cache_part(content_hash);
    preview_cache_dir().join(format!("{}-{}-{}.html", space, id, content_hash))
}

// ─── Migration ───
// On startup, if .md files live in Raynote/ root (legacy pre-spaces layout),
// move them to Raynote/Spaces/default/. The migration is per-file idempotent:
// only renames when the destination doesn't already exist, so re-runs are
// safe even if iCloud sync interrupts a previous attempt.
fn migrate_legacy_layout() {
    let root = raynote_root_dir();
    let default_space = space_notes_dir(DEFAULT_SPACE_ID);

    // Move .md files from root → Spaces/default/
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().map_or(false, |e| e == "md") {
                if let Some(name) = path.file_name() {
                    let dest = default_space.join(name);
                    if !dest.exists() {
                        let _ = fs::rename(&path, &dest);
                    }
                }
            }
        }
    }

    // Move legacy .trash → Spaces/default/.trash
    let legacy_trash = root.join(".trash");
    if legacy_trash.is_dir() {
        let new_trash = space_trash_dir(DEFAULT_SPACE_ID);
        if let Ok(entries) = fs::read_dir(&legacy_trash) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if path.extension().map_or(false, |e| e == "md") {
                    if let Some(name) = path.file_name() {
                        let dest = new_trash.join(name);
                        if !dest.exists() {
                            let _ = fs::rename(&path, &dest);
                        }
                    }
                }
            }
        }
        let _ = fs::remove_dir(&legacy_trash);
    }

    // Move pre-spaces meta cache → default-space meta cache
    let legacy_cache = legacy_notes_meta_cache_path();
    let new_cache = notes_meta_cache_path(DEFAULT_SPACE_ID);
    if legacy_cache.exists() && !new_cache.exists() {
        let _ = fs::rename(&legacy_cache, &new_cache);
    }
}

// ─── Data types ───
#[derive(Serialize, Deserialize, Clone)]
struct NoteMeta {
    id: String,
    title: String,
    modified: u64,
    preview: String,
}

#[derive(Serialize, Clone)]
struct ScanNoteEvent {
    space: String,
    meta: NoteMeta,
}

#[derive(Serialize, Clone)]
struct LoadingProgress {
    space: String,
    done: usize,
    total: usize,
}

#[derive(Serialize, Clone)]
struct SpaceLoadedEvent {
    space: String,
}

#[derive(Serialize, Deserialize)]
struct PaginatedNotes {
    notes: Vec<NoteMeta>,
    total: usize,
}

#[derive(Serialize, Deserialize)]
struct NotesMetaCache {
    version: u32,
    notes: Vec<NoteMeta>,
}

const NOTES_META_CACHE_VERSION: u32 = 1;

struct AppState {
    /// Per-space note metadata caches. Lazily populated as the user switches
    /// into a space; the default space is pre-loaded from disk at boot.
    notes_caches: RwLock<HashMap<String, Vec<NoteMeta>>>,
    /// True once the initial iCloud scan has completed for a given space.
    /// The frontend uses this to disambiguate "no notes" vs "still scanning".
    scans_done: RwLock<HashMap<String, bool>>,
    /// True while a scan is currently running for that space — used to avoid
    /// firing duplicate scans when the frontend re-enters a space.
    scans_in_progress: RwLock<HashMap<String, bool>>,
    capture_shortcut: RwLock<Option<Shortcut>>,
    toggle_shortcut: RwLock<Option<Shortcut>>,
}

fn read_notes_meta_cache(space_id: &str) -> Vec<NoteMeta> {
    let Ok(raw) = fs::read_to_string(notes_meta_cache_path(space_id)) else {
        return Vec::new();
    };
    let Ok(mut cache) = serde_json::from_str::<NotesMetaCache>(&raw) else {
        return Vec::new();
    };
    if cache.version != NOTES_META_CACHE_VERSION {
        return Vec::new();
    }
    cache.notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    cache.notes
}

fn write_notes_meta_cache(space_id: &str, notes: &[NoteMeta]) {
    let cache = NotesMetaCache {
        version: NOTES_META_CACHE_VERSION,
        notes: notes.to_vec(),
    };
    if let Ok(json) = serde_json::to_string(&cache) {
        let _ = fs::write(notes_meta_cache_path(space_id), json);
    }
}

const MAX_TITLE_LEN: usize = 80;

fn truncate_title(title: String) -> String {
    if title.chars().count() <= MAX_TITLE_LEN {
        return title;
    }
    let mut truncated: String = title.chars().take(MAX_TITLE_LEN).collect();
    truncated.push('…');
    truncated
}

fn parse_note_meta(id: String, content: &str, modified: u64) -> NoteMeta {
    let title = content
        .lines()
        .next()
        .unwrap_or(&id)
        .trim_start_matches('#')
        .trim()
        .to_string();
    let title = if title.is_empty() {
        id.clone()
    } else if title == "{{auto_generate}}" {
        "New Note".to_string()
    } else {
        truncate_title(title)
    };
    let preview = content
        .lines()
        .skip(1)
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(100)
        .collect();
    NoteMeta {
        id,
        title,
        modified,
        preview,
    }
}

/// Read just enough of a note to derive its metadata.
///
/// `parse_note_meta` only looks at the first line (title) and the next two
/// (preview), so reading the whole file is wasteful — and actively slow here,
/// since notes live in iCloud Drive where a full read of an evicted file
/// triggers a blocking download. One bounded read of the head of the file is
/// plenty for a title + 100-char preview and keeps the startup scan cheap.
fn read_meta_prefix(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut buf = [0u8; 4096];
    let n = file.read(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

fn note_meta_from_md_path(path: &Path) -> Option<NoteMeta> {
    if !path.extension().map_or(false, |e| e == "md") {
        return None;
    }
    let id = path.file_stem()?.to_string_lossy().to_string();
    let content = read_meta_prefix(path).ok()?;
    let modified = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(parse_note_meta(id, &content, modified))
}

/// Read all note metadata for one space, sorted by modified desc.
///
/// Emits `note-meta-loaded` per file (tagged with the space id) so the
/// frontend can fill its sidebar progressively, and `notes-loading-progress`
/// while scanning. Uses an mtime fast-path against `previous`:
/// `fs::metadata().modified()` does not trigger an iCloud download, so any
/// file whose timestamp matches the cached entry can reuse it directly and
/// skip the (potentially-blocking) prefix read.
fn read_all_notes(handle: &AppHandle, space_id: &str, previous: &[NoteMeta]) -> Vec<NoteMeta> {
    use std::collections::HashMap as Map;

    let dir = space_notes_dir(space_id);
    let paths: Vec<PathBuf> = match fs::read_dir(&dir) {
        Ok(it) => it
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().map_or(false, |e| e == "md"))
            .collect(),
        Err(_) => Vec::new(),
    };
    let total = paths.len();

    let cached: Map<&str, &NoteMeta> = previous.iter().map(|n| (n.id.as_str(), n)).collect();

    let mut notes: Vec<NoteMeta> = Vec::with_capacity(total);

    for (idx, path) in paths.into_iter().enumerate() {
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        let modified = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let meta = match cached.get(id.as_str()) {
            Some(c) if c.modified == modified => (*c).clone(),
            _ => {
                let content = read_meta_prefix(&path).unwrap_or_default();
                parse_note_meta(id, &content, modified)
            }
        };

        let _ = handle.emit(
            "note-meta-loaded",
            ScanNoteEvent {
                space: space_id.to_string(),
                meta: meta.clone(),
            },
        );
        notes.push(meta);
        let _ = handle.emit(
            "notes-loading-progress",
            LoadingProgress {
                space: space_id.to_string(),
                done: idx + 1,
                total,
            },
        );
    }

    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    notes
}

/// Kick off a background scan thread for one space. Idempotent — if a scan
/// for this space is already running, returns false without starting another.
fn spawn_scan_for_space(handle: AppHandle, space_id: String) -> bool {
    {
        let state = handle.state::<AppState>();
        let mut in_progress = state.scans_in_progress.write().unwrap();
        if *in_progress.get(&space_id).unwrap_or(&false) {
            return false;
        }
        in_progress.insert(space_id.clone(), true);
    }

    std::thread::spawn(move || {
        let previous: Vec<NoteMeta> = {
            let state = handle.state::<AppState>();
            let caches = state.notes_caches.read().unwrap();
            caches.get(&space_id).cloned().unwrap_or_default()
        };
        let notes = read_all_notes(&handle, &space_id, &previous);
        write_notes_meta_cache(&space_id, &notes);

        // Hydrate the most-recent note into the OS file cache so the
        // frontend's auto-select doesn't trigger another iCloud download
        // immediately after the sidebar finishes filling.
        if let Some(first) = notes.first() {
            let _ = fs::read_to_string(space_notes_dir(&space_id).join(format!("{}.md", first.id)));
        }

        {
            let state = handle.state::<AppState>();
            state
                .notes_caches
                .write()
                .unwrap()
                .insert(space_id.clone(), notes);
            state
                .scans_done
                .write()
                .unwrap()
                .insert(space_id.clone(), true);
            state
                .scans_in_progress
                .write()
                .unwrap()
                .insert(space_id.clone(), false);
        }
        let _ = handle.emit("notes-loaded", SpaceLoadedEvent { space: space_id });
    });

    true
}

// ─── Commands ───

/// Return the cached note list for a space. Caller should call
/// `scan_space` first if `notes_loading(space)` returns true and they want
/// fresh data from iCloud.
#[tauri::command]
fn list_notes(state: State<'_, AppState>, space: String) -> Vec<NoteMeta> {
    state
        .notes_caches
        .read()
        .unwrap()
        .get(&space)
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
fn list_notes_paginated(
    state: State<'_, AppState>,
    space: String,
    offset: usize,
    limit: usize,
) -> PaginatedNotes {
    let cache = state.notes_caches.read().unwrap();
    let space_notes = cache.get(&space);
    let total = space_notes.map(|v| v.len()).unwrap_or(0);
    let notes = space_notes
        .map(|v| v.iter().skip(offset).take(limit).cloned().collect())
        .unwrap_or_default();
    PaginatedNotes { notes, total }
}

#[tauri::command]
fn search_notes(
    state: State<'_, AppState>,
    space: String,
    query: String,
    limit: usize,
) -> Vec<NoteMeta> {
    let q = query.to_lowercase();
    let cache = state.notes_caches.read().unwrap();
    cache
        .get(&space)
        .map(|v| {
            v.iter()
                .filter(|n| {
                    n.title.to_lowercase().contains(&q) || n.preview.to_lowercase().contains(&q)
                })
                .take(limit)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// True while the iCloud scan for a space is running (or hasn't started yet).
#[tauri::command]
fn notes_loading(state: State<'_, AppState>, space: String) -> bool {
    !*state.scans_done.read().unwrap().get(&space).unwrap_or(&false)
}

/// Start a background scan for a space if one isn't already in progress.
/// Seeds the in-memory cache from the on-disk meta cache so list_notes
/// returns useful data immediately. Returns true if a new scan was started.
#[tauri::command]
fn scan_space(app: AppHandle, state: State<'_, AppState>, space: String) -> bool {
    {
        // Seed cache from disk if we've never touched this space before.
        let mut caches = state.notes_caches.write().unwrap();
        caches
            .entry(space.clone())
            .or_insert_with(|| read_notes_meta_cache(&space));
    }
    spawn_scan_for_space(app, space)
}

#[tauri::command]
fn read_note(space: String, id: String) -> String {
    let path = space_notes_dir(&space).join(format!("{}.md", id));
    fs::read_to_string(path).unwrap_or_default()
}

#[tauri::command]
fn read_preview_cache(space: String, id: String, content_hash: String) -> Option<String> {
    let path = preview_cache_path(&space, &id, &content_hash);
    fs::read_to_string(path).ok()
}

#[tauri::command]
fn write_preview_cache(space: String, id: String, content_hash: String, html: String) -> bool {
    let path = preview_cache_path(&space, &id, &content_hash);
    fs::write(path, html).is_ok()
}

#[tauri::command]
fn delete_preview_cache(space: String, id: String) -> bool {
    let prefix = format!("{}-{}-", safe_cache_part(&space), safe_cache_part(&id));
    let dir = preview_cache_dir();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with(&prefix) && name.ends_with(".html") {
                let _ = fs::remove_file(path);
            }
        }
    }
    true
}

#[tauri::command]
fn save_note(state: State<'_, AppState>, space: String, id: String, content: String) -> bool {
    let path = space_notes_dir(&space).join(format!("{}.md", &id));
    if fs::write(&path, &content).is_ok() {
        let modified = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let meta = parse_note_meta(id.clone(), &content, modified);
        let mut caches = state.notes_caches.write().unwrap();
        let cache = caches.entry(space.clone()).or_insert_with(Vec::new);
        if let Some(idx) = cache.iter().position(|n| n.id == id) {
            cache[idx] = meta;
        } else {
            cache.push(meta);
        }
        cache.sort_by(|a, b| b.modified.cmp(&a.modified));
        write_notes_meta_cache(&space, cache);
        true
    } else {
        false
    }
}

#[tauri::command]
fn delete_note(state: State<'_, AppState>, space: String, id: String) -> bool {
    let path = space_notes_dir(&space).join(format!("{}.md", id));
    if path.exists() {
        let trash_path = space_trash_dir(&space).join(format!("{}.md", id));
        if fs::rename(&path, &trash_path).is_ok() {
            let mut caches = state.notes_caches.write().unwrap();
            if let Some(cache) = caches.get_mut(&space) {
                cache.retain(|n| n.id != id);
                write_notes_meta_cache(&space, cache);
            }
            true
        } else {
            false
        }
    } else {
        false
    }
}

#[tauri::command]
fn restore_note(state: State<'_, AppState>, space: String, id: String) -> bool {
    let trash_path = space_trash_dir(&space).join(format!("{}.md", id));
    let notes_path = space_notes_dir(&space).join(format!("{}.md", id));
    if trash_path.exists() && !notes_path.exists() {
        if fs::rename(&trash_path, &notes_path).is_ok() {
            if let Some(meta) = note_meta_from_md_path(&notes_path) {
                let mut caches = state.notes_caches.write().unwrap();
                let cache = caches.entry(space.clone()).or_insert_with(Vec::new);
                if !cache.iter().any(|n| n.id == id) {
                    cache.push(meta);
                    cache.sort_by(|a, b| b.modified.cmp(&a.modified));
                    write_notes_meta_cache(&space, cache);
                }
            }
            true
        } else {
            false
        }
    } else {
        false
    }
}

#[tauri::command]
fn list_trash(space: String) -> Vec<NoteMeta> {
    let dir = space_trash_dir(&space);
    let mut notes: Vec<NoteMeta> = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "md") {
                let id = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let content = fs::read_to_string(&path).unwrap_or_default();
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                notes.push(parse_note_meta(id, &content, modified));
            }
        }
    }

    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    notes
}

#[tauri::command]
fn empty_trash(space: String) -> bool {
    let dir = space_trash_dir(&space);
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = fs::remove_file(path);
            }
        }
        true
    } else {
        false
    }
}

#[tauri::command]
fn permanently_delete_note(space: String, id: String) -> bool {
    let path = space_trash_dir(&space).join(format!("{}.md", id));
    if path.exists() {
        fs::remove_file(path).is_ok()
    } else {
        false
    }
}

#[tauri::command]
fn rename_note(
    state: State<'_, AppState>,
    space: String,
    old_id: String,
    new_id: String,
) -> bool {
    let old_path = space_notes_dir(&space).join(format!("{}.md", &old_id));
    let new_path = space_notes_dir(&space).join(format!("{}.md", &new_id));
    if old_path.exists() && !new_path.exists() {
        if fs::rename(&old_path, &new_path).is_ok() {
            let mut caches = state.notes_caches.write().unwrap();
            if let Some(cache) = caches.get_mut(&space) {
                if let Some(idx) = cache.iter().position(|n| n.id == old_id) {
                    cache[idx].id = new_id;
                    write_notes_meta_cache(&space, cache);
                }
            }
            true
        } else {
            false
        }
    } else {
        false
    }
}

/// Move a note's .md file from one space to another. Caches for both
/// spaces are updated. Asset references inside the note remain valid because
/// assets live in a shared folder (see `assets_dir`).
#[tauri::command]
fn move_note_to_space(
    state: State<'_, AppState>,
    from_space: String,
    to_space: String,
    id: String,
) -> Result<(), String> {
    if from_space == to_space {
        return Ok(());
    }
    let src = space_notes_dir(&from_space).join(format!("{}.md", id));
    if !src.exists() {
        return Err("Source note not found".into());
    }
    let dest_dir = space_notes_dir(&to_space);
    let dest = dest_dir.join(format!("{}.md", id));
    if dest.exists() {
        return Err("A note with this id already exists in the target space".into());
    }
    fs::rename(&src, &dest).map_err(|e| e.to_string())?;

    let modified = fs::metadata(&dest)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let content = read_meta_prefix(&dest).unwrap_or_default();
    let meta = parse_note_meta(id.clone(), &content, modified);

    let mut caches = state.notes_caches.write().unwrap();
    if let Some(from_cache) = caches.get_mut(&from_space) {
        from_cache.retain(|n| n.id != id);
        write_notes_meta_cache(&from_space, from_cache);
    }
    let to_cache = caches.entry(to_space.clone()).or_insert_with(Vec::new);
    if !to_cache.iter().any(|n| n.id == id) {
        to_cache.push(meta);
        to_cache.sort_by(|a, b| b.modified.cmp(&a.modified));
    }
    write_notes_meta_cache(&to_space, to_cache);

    // Clear preview cache entries for this note in the source space — they
    // were keyed by source space id, so they can't be reused after the move.
    let prefix = format!(
        "{}-{}-",
        safe_cache_part(&from_space),
        safe_cache_part(&id)
    );
    if let Ok(entries) = fs::read_dir(preview_cache_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with(&prefix) && name.ends_with(".html") {
                let _ = fs::remove_file(path);
            }
        }
    }

    Ok(())
}

/// Permanently delete a space — removes its folder (notes + trash) on disk
/// and drops it from the in-memory caches. The frontend is responsible for
/// confirming with the user; this is irreversible (apart from iCloud's own
/// versioning). The default space can't be deleted.
#[tauri::command]
fn delete_space(state: State<'_, AppState>, space: String) -> Result<(), String> {
    if space == DEFAULT_SPACE_ID {
        return Err("Cannot delete the default space".into());
    }
    let safe = sanitize_space_id(&space);
    if safe == DEFAULT_SPACE_ID {
        return Err("Cannot delete the default space".into());
    }
    let dir = spaces_root_dir().join(&safe);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    state.notes_caches.write().unwrap().remove(&space);
    state.scans_done.write().unwrap().remove(&space);
    state.scans_in_progress.write().unwrap().remove(&space);
    let _ = fs::remove_file(notes_meta_cache_path(&space));

    // Clear any preview cache files for this space.
    let prefix = format!("{}-", safe_cache_part(&space));
    if let Ok(entries) = fs::read_dir(preview_cache_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with(&prefix) && name.ends_with(".html") {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn set_dock_visible(visible: bool) {
    #[cfg(target_os = "macos")]
    {
        use objc::{msg_send, sel, sel_impl};
        unsafe {
            let app: *mut objc::runtime::Object =
                msg_send![objc::class!(NSApplication), sharedApplication];
            // 0 = NSApplicationActivationPolicyRegular (show in dock)
            // 1 = NSApplicationActivationPolicyAccessory (hide from dock)
            let policy: i64 = if visible { 0 } else { 1 };
            let _: () = msg_send![app, setActivationPolicy: policy];
        }
    }
}

#[tauri::command]
fn save_asset(name: String, data_base64: String) -> Result<String, String> {
    let dir = assets_dir();
    let data = general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(name)
}

#[tauri::command]
fn read_asset(name: String) -> Result<String, String> {
    let path = assets_dir().join(&name);
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(&data))
}

#[tauri::command]
fn reveal_asset(name: String) -> Result<(), String> {
    let path = assets_dir().join(&name);
    if !path.exists() {
        return Err("Asset not found".into());
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn copy_to_assets(source_path: String) -> Result<(String, String), String> {
    let source = std::path::Path::new(&source_path);
    if !source.exists() {
        return Err("Source file not found".into());
    }
    let original_name = source
        .file_name()
        .ok_or("Invalid filename")?
        .to_string_lossy()
        .to_string();
    let safe_name = original_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let asset_name = format!("{}-{}", ts, safe_name);

    let dir = assets_dir();
    let dest = dir.join(&asset_name);
    fs::copy(source, &dest).map_err(|e| e.to_string())?;
    Ok((asset_name, original_name))
}

fn apply_glass_effects(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        window_vibrancy::apply_vibrancy(
            win,
            window_vibrancy::NSVisualEffectMaterial::HudWindow,
            Some(window_vibrancy::NSVisualEffectState::Active),
            Some(12.0),
        )
        .expect("Failed to apply macOS vibrancy");

        use objc::{msg_send, sel, sel_impl};
        use raw_window_handle::HasWindowHandle;

        if let Ok(handle) = win.window_handle() {
            match handle.as_raw() {
                raw_window_handle::RawWindowHandle::AppKit(appkit) => unsafe {
                    let ns_view = appkit.ns_view.as_ptr() as *mut objc::runtime::Object;
                    let ns_window: *mut objc::runtime::Object = msg_send![ns_view, window];
                    let content_view: *mut objc::runtime::Object =
                        msg_send![ns_window, contentView];
                    let () = msg_send![content_view, setWantsLayer: true];
                    let layer: *mut objc::runtime::Object = msg_send![content_view, layer];
                    let () = msg_send![layer, setCornerRadius: 12.0_f64];
                    let () = msg_send![layer, setMasksToBounds: true];
                },
                _ => {}
            }
        }
    }

    #[cfg(target_os = "windows")]
    window_vibrancy::apply_blur(win, Some((18, 18, 24, 125)))
        .expect("Failed to apply Windows blur");
}

#[tauri::command]
fn create_sticky_window(app: tauri::AppHandle, space: String, id: String) -> Result<(), String> {
    let path = space_notes_dir(&space).join(format!("{}.md", id));
    if !path.is_file() {
        return Err("Note not found".into());
    }

    let window_label = format!(
        "sticky-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );

    let url = format!("index.html?sticky=1&id={}&space={}", id, space);
    let win = WebviewWindowBuilder::new(&app, &window_label, WebviewUrl::App(url.into()))
        .title("Sticky")
        .inner_size(320.0, 440.0)
        .min_inner_size(220.0, 200.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;

    apply_glass_effects(&win);
    Ok(())
}

/// Replace the registered global shortcut for a given role.
///
/// `role` is `"capture"` or `"toggle"`. `accelerator` is in the format the
/// global-shortcut plugin accepts (e.g. `"Ctrl+Cmd+Alt+Shift+KeyN"`).
///
/// On success the previous binding for that role is unregistered. On failure
/// (parse error, OS-level conflict with another app, etc.) the previous
/// binding is left in place and an error string is returned to the caller.
#[tauri::command]
fn set_global_shortcut(
    app: AppHandle,
    state: State<'_, AppState>,
    role: String,
    accelerator: String,
) -> Result<(), String> {
    let new_shortcut = Shortcut::from_str(&accelerator)
        .map_err(|e| format!("Could not parse shortcut '{}': {}", accelerator, e))?;

    let slot = match role.as_str() {
        GS_ROLE_CAPTURE => &state.capture_shortcut,
        GS_ROLE_TOGGLE => &state.toggle_shortcut,
        other => return Err(format!("Unknown shortcut role: {}", other)),
    };

    // No-op if the same accelerator is already registered for this role.
    if let Some(current) = *slot.read().unwrap() {
        if current == new_shortcut {
            return Ok(());
        }
    }

    // Try to register the new one first. If that fails (already taken,
    // OS-reserved combo, etc.), bail without touching the existing binding.
    app.global_shortcut()
        .register(new_shortcut)
        .map_err(|e| format!("Could not register '{}': {}", accelerator, e))?;

    // Now unregister the old one (best-effort — if it errors we still keep
    // the new one registered, since that's the user's intent).
    let old = *slot.read().unwrap();
    if let Some(old_shortcut) = old {
        if old_shortcut != new_shortcut {
            let _ = app.global_shortcut().unregister(old_shortcut);
        }
    }

    *slot.write().unwrap() = Some(new_shortcut);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != GsShortcutState::Pressed {
                        return;
                    }
                    let state = app.state::<AppState>();
                    let capture = *state.capture_shortcut.read().unwrap();
                    let toggle = *state.toggle_shortcut.read().unwrap();

                    let Some(window) = app.get_webview_window("main") else {
                        return;
                    };

                    if Some(*shortcut) == capture {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("quick-capture", ());
                    } else if Some(*shortcut) == toggle {
                        let main_visible = window.is_visible().unwrap_or(false);
                        let main_focused = window.is_focused().unwrap_or(false);
                        let sticky_focused = app.webview_windows().iter().any(|(label, w)| {
                            label.starts_with("sticky-") && w.is_focused().unwrap_or(false)
                        });
                        let app_in_foreground = main_focused || sticky_focused;

                        if main_visible && app_in_foreground {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let capture = default_capture_shortcut();
            let toggle = default_toggle_shortcut();

            // Run the legacy → spaces migration before anything reads from disk.
            // Per-file idempotent, so it's safe on every boot.
            migrate_legacy_layout();

            // Pre-seed the default space's metadata cache so the sidebar can
            // render before iCloud catches up. Other spaces are seeded lazily
            // when the user first switches into them.
            let default_cached = read_notes_meta_cache(DEFAULT_SPACE_ID);
            let mut notes_caches: HashMap<String, Vec<NoteMeta>> = HashMap::new();
            notes_caches.insert(DEFAULT_SPACE_ID.to_string(), default_cached);

            app.manage(AppState {
                notes_caches: RwLock::new(notes_caches),
                scans_done: RwLock::new(HashMap::new()),
                scans_in_progress: RwLock::new(HashMap::new()),
                capture_shortcut: RwLock::new(Some(capture)),
                toggle_shortcut: RwLock::new(Some(toggle)),
            });

            // Scan the default space off the main thread so the window can
            // appear immediately. Other spaces scan on first switch.
            spawn_scan_for_space(app.handle().clone(), DEFAULT_SPACE_ID.to_string());

            // Register the default global shortcuts. If either fails (e.g. another
            // running app already grabbed the combo), null out the role in state
            // so the frontend's set_global_shortcut call can take over cleanly.
            if app.global_shortcut().register(capture).is_err() {
                *app.state::<AppState>().capture_shortcut.write().unwrap() = None;
            }
            if app.global_shortcut().register(toggle).is_err() {
                *app.state::<AppState>().toggle_shortcut.write().unwrap() = None;
            }

            // Get the main window
            let win = app.get_webview_window("main").unwrap();
            apply_glass_effects(&win);

            // Setup system tray
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("Raynote")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_notes,
            list_notes_paginated,
            notes_loading,
            scan_space,
            search_notes,
            read_note,
            read_preview_cache,
            write_preview_cache,
            delete_preview_cache,
            save_note,
            delete_note,
            restore_note,
            list_trash,
            empty_trash,
            permanently_delete_note,
            rename_note,
            move_note_to_space,
            delete_space,
            set_dock_visible,
            save_asset,
            read_asset,
            copy_to_assets,
            reveal_asset,
            create_sticky_window,
            set_global_shortcut,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Raynote")
        .run(|_app_handle, _event| {
            // The main window is hidden (not closed) when dismissed, so the
            // app keeps its dock icon. Clicking that icon fires Reopen
            // (applicationShouldHandleReopen) instead of restoring the
            // window — macOS won't unhide it for us. Always bring it back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
