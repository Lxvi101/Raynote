use base64::{Engine as _, engine::general_purpose};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{WebviewWindow, WebviewWindowBuilder},
    Emitter, Manager, State, WebviewUrl,
};

fn notes_dir() -> PathBuf {
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

fn trash_dir() -> PathBuf {
    let dir = notes_dir().join(".trash");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create trash directory");
    }
    dir
}

#[derive(Serialize, Deserialize, Clone)]
struct NoteMeta {
    id: String,
    title: String,
    modified: u64,
    preview: String,
}

#[derive(Serialize, Deserialize)]
struct PaginatedNotes {
    notes: Vec<NoteMeta>,
    total: usize,
}

struct AppState {
    notes_cache: RwLock<Vec<NoteMeta>>,
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
        title
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

fn note_meta_from_md_path(path: &Path) -> Option<NoteMeta> {
    if !path.extension().map_or(false, |e| e == "md") {
        return None;
    }
    let id = path.file_stem()?.to_string_lossy().to_string();
    let content = fs::read_to_string(path).ok()?;
    let modified = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(parse_note_meta(id, &content, modified))
}

/// Read all note metadata from disk, sorted by modified desc (startup / full rescan only).
fn read_all_notes() -> Vec<NoteMeta> {
    let dir = notes_dir();
    let mut notes: Vec<NoteMeta> = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(meta) = note_meta_from_md_path(&entry.path()) {
                notes.push(meta);
            }
        }
    }

    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    notes
}

#[tauri::command]
fn list_notes(state: State<'_, AppState>) -> Vec<NoteMeta> {
    state.notes_cache.read().unwrap().clone()
}

#[tauri::command]
fn list_notes_paginated(state: State<'_, AppState>, offset: usize, limit: usize) -> PaginatedNotes {
    let cache = state.notes_cache.read().unwrap();
    let total = cache.len();
    let notes = cache
        .iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect();
    PaginatedNotes { notes, total }
}

#[tauri::command]
fn search_notes(state: State<'_, AppState>, query: String, limit: usize) -> Vec<NoteMeta> {
    let q = query.to_lowercase();
    let cache = state.notes_cache.read().unwrap();
    cache
        .iter()
        .filter(|n| {
            n.title.to_lowercase().contains(&q) || n.preview.to_lowercase().contains(&q)
        })
        .take(limit)
        .cloned()
        .collect()
}

#[tauri::command]
fn read_note(id: String) -> String {
    let path = notes_dir().join(format!("{}.md", id));
    fs::read_to_string(path).unwrap_or_default()
}

#[tauri::command]
fn save_note(state: State<'_, AppState>, id: String, content: String) -> bool {
    let path = notes_dir().join(format!("{}.md", &id));
    if fs::write(&path, &content).is_ok() {
        let modified = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let meta = parse_note_meta(id.clone(), &content, modified);
        let mut cache = state.notes_cache.write().unwrap();
        if let Some(idx) = cache.iter().position(|n| n.id == id) {
            cache[idx] = meta;
        } else {
            cache.push(meta);
        }
        cache.sort_by(|a, b| b.modified.cmp(&a.modified));
        true
    } else {
        false
    }
}

#[tauri::command]
fn delete_note(state: State<'_, AppState>, id: String) -> bool {
    let path = notes_dir().join(format!("{}.md", id));
    if path.exists() {
        let trash_path = trash_dir().join(format!("{}.md", id));
        if fs::rename(&path, &trash_path).is_ok() {
            let mut cache = state.notes_cache.write().unwrap();
            cache.retain(|n| n.id != id);
            true
        } else {
            false
        }
    } else {
        false
    }
}

#[tauri::command]
fn restore_note(state: State<'_, AppState>, id: String) -> bool {
    let trash_path = trash_dir().join(format!("{}.md", id));
    let notes_path = notes_dir().join(format!("{}.md", id));
    if trash_path.exists() && !notes_path.exists() {
        if fs::rename(&trash_path, &notes_path).is_ok() {
            if let Some(meta) = note_meta_from_md_path(&notes_path) {
                let mut cache = state.notes_cache.write().unwrap();
                if !cache.iter().any(|n| n.id == id) {
                    cache.push(meta);
                    cache.sort_by(|a, b| b.modified.cmp(&a.modified));
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
fn list_trash() -> Vec<NoteMeta> {
    let dir = trash_dir();
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
                let title = content
                    .lines()
                    .next()
                    .unwrap_or(&id)
                    .trim_start_matches('#')
                    .trim()
                    .to_string();
                let title = if title.is_empty() {
                    id.clone()
                } else {
                    title
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
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                notes.push(NoteMeta {
                    id,
                    title,
                    modified,
                    preview,
                });
            }
        }
    }

    notes.sort_by(|a, b| b.modified.cmp(&a.modified));
    notes
}

#[tauri::command]
fn empty_trash() -> bool {
    let dir = trash_dir();
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
fn permanently_delete_note(id: String) -> bool {
    let path = trash_dir().join(format!("{}.md", id));
    if path.exists() {
        fs::remove_file(path).is_ok()
    } else {
        false
    }
}

#[tauri::command]
fn set_dock_visible(visible: bool) {
    #[cfg(target_os = "macos")]
    {
        use objc::{msg_send, sel, sel_impl};
        unsafe {
            let app: *mut objc::runtime::Object = msg_send![objc::class!(NSApplication), sharedApplication];
            // 0 = NSApplicationActivationPolicyRegular (show in dock)
            // 1 = NSApplicationActivationPolicyAccessory (hide from dock)
            let policy: i64 = if visible { 0 } else { 1 };
            let _: () = msg_send![app, setActivationPolicy: policy];
        }
    }
}

#[tauri::command]
fn save_asset(name: String, data_base64: String) -> Result<String, String> {
    let dir = notes_dir().join("assets");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let data = general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(name)
}

#[tauri::command]
fn read_asset(name: String) -> Result<String, String> {
    let path = notes_dir().join("assets").join(&name);
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(&data))
}

#[tauri::command]
fn reveal_asset(name: String) -> Result<(), String> {
    let path = notes_dir().join("assets").join(&name);
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
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let asset_name = format!("{}-{}", ts, safe_name);

    let dir = notes_dir().join("assets");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let dest = dir.join(&asset_name);
    fs::copy(source, &dest).map_err(|e| e.to_string())?;
    Ok((asset_name, original_name))
}

#[tauri::command]
fn rename_note(state: State<'_, AppState>, old_id: String, new_id: String) -> bool {
    let old_path = notes_dir().join(format!("{}.md", &old_id));
    let new_path = notes_dir().join(format!("{}.md", &new_id));
    if old_path.exists() && !new_path.exists() {
        if fs::rename(&old_path, &new_path).is_ok() {
            let mut cache = state.notes_cache.write().unwrap();
            if let Some(idx) = cache.iter().position(|n| n.id == old_id) {
                cache[idx].id = new_id;
            }
            true
        } else {
            false
        }
    } else {
        false
    }
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
    window_vibrancy::apply_blur(win, Some((18, 18, 24, 125))).expect("Failed to apply Windows blur");
}

#[tauri::command]
fn create_sticky_window(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = notes_dir().join(format!("{}.md", id));
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

    let url = format!("index.html?sticky=1&id={}", id);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let shortcut_str = shortcut.to_string();
                        if let Some(window) = app.get_webview_window("main") {
                            if shortcut_str.contains("N") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.emit("quick-capture", ());
                            } else if shortcut_str.contains("M") {
                                let main_visible = window.is_visible().unwrap_or(false);
                                let main_focused = window.is_focused().unwrap_or(false);
                                let sticky_focused = app.webview_windows().iter().any(|(label, w)| {
                                    label.starts_with("sticky-")
                                        && w.is_focused().unwrap_or(false)
                                });
                                let app_in_foreground = main_focused || sticky_focused;

                                if main_visible && app_in_foreground {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            let initial_notes = read_all_notes();
            app.manage(AppState {
                notes_cache: RwLock::new(initial_notes),
            });

            // Register global shortcut: Ctrl+Cmd+Option+Shift+N
            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
            let shortcut = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::META | Modifiers::ALT | Modifiers::SHIFT),
                Code::KeyN,
            );
            app.global_shortcut().register(shortcut)?;

            // Register global shortcut: Ctrl+Cmd+Option+Shift+M (toggle window)
            let toggle_shortcut = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::META | Modifiers::ALT | Modifiers::SHIFT),
                Code::KeyM,
            );
            app.global_shortcut().register(toggle_shortcut)?;

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
            search_notes,
            read_note,
            save_note,
            delete_note,
            restore_note,
            list_trash,
            empty_trash,
            permanently_delete_note,
            rename_note,
            set_dock_visible,
            save_asset,
            read_asset,
            copy_to_assets,
            reveal_asset,
            create_sticky_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Raynote");
}
