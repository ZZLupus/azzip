use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::archive::zip::ZipHandler;
use crate::archive::{ArchiveEntry, ArchiveHandler, Progress};

/// DTO sent to the frontend (mirrors ArchiveEntry).
#[derive(Serialize)]
pub struct ArchiveEntryDto {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

impl From<ArchiveEntry> for ArchiveEntryDto {
    fn from(e: ArchiveEntry) -> Self {
        ArchiveEntryDto { path: e.path, size: e.size, is_dir: e.is_dir }
    }
}

/// Progress payload emitted on the "extract-progress" event.
#[derive(Serialize, Clone)]
pub struct ProgressDto {
    pub current_file: String,
    pub files_done: usize,
    pub files_total: usize,
}

impl From<Progress> for ProgressDto {
    fn from(p: Progress) -> Self {
        ProgressDto {
            current_file: p.current_file,
            files_done: p.files_done,
            files_total: p.files_total,
        }
    }
}

#[tauri::command]
pub async fn list_archive(path: String) -> Result<Vec<ArchiveEntryDto>, String> {
    let archive = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        ZipHandler
            .list(&archive)
            .map(|v| v.into_iter().map(Into::into).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extract_archive(
    app: AppHandle,
    path: String,
    dest: String,
) -> Result<(), String> {
    let archive = PathBuf::from(path);
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || {
        ZipHandler
            .extract(&archive, &dest, &mut |p: Progress| {
                // Best-effort progress emit; ignore send errors.
                let _ = app.emit("extract-progress", ProgressDto::from(p));
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
