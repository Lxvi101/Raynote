use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

fn notes_dir() -> PathBuf {
    let home = dirs_next::home_dir().expect("Could not find home directory");
    let dir = home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs")
        .join("LeviNote");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("Could not create notes directory in iCloud");
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

#[tauri::command]
fn list_notes() -> Vec<NoteMeta> {
    let dir = notes_dir();
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
fn read_note(id: String) -> String {
    let path = notes_dir().join(format!("{}.md", id));
    fs::read_to_string(path).unwrap_or_default()
}

#[tauri::command]
fn save_note(id: String, content: String) -> bool {
    let path = notes_dir().join(format!("{}.md", id));
    fs::write(path, content).is_ok()
}

#[tauri::command]
fn delete_note(id: String) -> bool {
    let path = notes_dir().join(format!("{}.md", id));
    if path.exists() {
        fs::remove_file(path).is_ok()
    } else {
        false
    }
}

#[tauri::command]
fn rename_note(old_id: String, new_id: String) -> bool {
    let old_path = notes_dir().join(format!("{}.md", old_id));
    let new_path = notes_dir().join(format!("{}.md", new_id));
    if old_path.exists() && !new_path.exists() {
        fs::rename(old_path, new_path).is_ok()
    } else {
        false
    }
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
                        if shortcut_str.contains("N") {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.emit("quick-capture", ());
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Register global shortcut: Cmd+Shift+N
            use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
            let shortcut = Shortcut::new(Some(Modifiers::META | Modifiers::SHIFT), Code::KeyN);
            app.global_shortcut().register(shortcut)?;

            // Get the main window
            let win = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "macos")]
            {
                // 1. Use a dark vibrancy material
                window_vibrancy::apply_vibrancy(
                    &win,
                    window_vibrancy::NSVisualEffectMaterial::HudWindow,
                    Some(window_vibrancy::NSVisualEffectState::Active),
                    Some(12.0),
                )
                .expect("Failed to apply macOS vibrancy");

                // 2. Restore native corner masking (needed when decorations: false)
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
                            let layer: *mut objc::runtime::Object =
                                msg_send![content_view, layer];
                            let () = msg_send![layer, setCornerRadius: 12.0_f64];
                            let () = msg_send![layer, setMasksToBounds: true];
                        },
                        _ => {}
                    }
                }
            }

            #[cfg(target_os = "windows")]
            window_vibrancy::apply_blur(&win, Some((18, 18, 24, 125)))
                .expect("Failed to apply Windows blur");

            // Setup system tray
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("LeviNote")
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
            read_note,
            save_note,
            delete_note,
            rename_note,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LeviNote");
}
