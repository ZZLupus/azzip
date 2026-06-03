// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod archive;
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                    // Translucent purple tint over the system Acrylic blur.
                    // A failure (older Windows without Acrylic) is non-fatal:
                    // the window simply falls back to its CSS translucency.
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
            commands::compress_files,
            commands::add_files_to_archive,
            commands::delete_entries
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
