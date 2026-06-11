// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod archive;
mod commands;

use std::sync::Mutex;

/// Path passed via CLI (e.g., double-clicking a file in Explorer).
static LAUNCH_FILE: Mutex<Option<String>> = Mutex::new(None);

/// Return the file path if the app was launched via file association,
/// then clear it so it doesn't reopen on next window focus.
#[tauri::command]
fn get_launch_file() -> Option<String> {
    LAUNCH_FILE.lock().unwrap().take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture CLI args early (before the webview is created).
    // args[1] is the file path when launched by double-click in Explorer.
    {
        let args: Vec<String> = std::env::args().collect();
        if args.len() >= 2 {
            let path = &args[1];
            let ext = std::path::Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let archive_exts = ["zip","7z","rar","tar","gz","tgz","bz2","tbz2","xz","txz"];
            if archive_exts.contains(&ext.as_str()) {
                *LAUNCH_FILE.lock().unwrap() = Some(path.clone());
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                use window_vibrancy::apply_acrylic;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = apply_acrylic(&window, Some((36, 27, 75, 120)));
                } else {
                    eprintln!("[azzip] setup: 'main' window not found; skipping Acrylic");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_archive,
            commands::extract_archive,
            commands::extract_entry,
            commands::extract_to_temp,
            commands::open_folder,
            commands::read_text_file,
            commands::read_file_base64,
            commands::compress_files,
            commands::add_files_to_archive,
            commands::delete_entries,
            get_launch_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
