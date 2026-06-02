use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::archive::{ArchiveHandler, Progress, TreeNode};
use crate::archive::router::get_handler;

/// DTO sent to the frontend (mirrors TreeNode).
#[derive(Serialize)]
pub struct TreeNodeDto {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub children: Vec<TreeNodeDto>,
}

impl From<TreeNode> for TreeNodeDto {
    fn from(n: TreeNode) -> Self {
        TreeNodeDto {
            name: n.name,
            path: n.path,
            size: n.size,
            is_dir: n.is_dir,
            children: n.children.into_iter().map(Into::into).collect(),
        }
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

/// Extract a single entry from an archive to a chosen directory.
/// Returns the path of the extracted item on disk.
#[tauri::command]
pub async fn extract_entry(
    archive_path: String,
    entry_path: String,
    dest_dir: String,
    password: Option<String>,
) -> Result<String, String> {
    let archive = PathBuf::from(archive_path);
    let dest = PathBuf::from(dest_dir);
    tauri::async_runtime::spawn_blocking(move || {
        get_handler(&archive)
            .map_err(|e| e.to_string())?
            .extract_entry(&archive, &entry_path, &dest, password.as_deref())
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extract a single entry to a system temp directory, return the temp path.
/// Used for drag-out: caller starts an OS drag with this path, then cleans up.
#[tauri::command]
pub async fn extract_to_temp(
    archive_path: String,
    entry_path: String,
    password: Option<String>,
) -> Result<String, String> {
    let archive = PathBuf::from(&archive_path);
    let tmp_dir = std::env::temp_dir().join(format!(
        "azzip_drag_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        get_handler(&archive)
            .map_err(|e| e.to_string())?
            .extract_entry(&archive, &entry_path, &tmp_dir, password.as_deref())
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a folder in Windows Explorer directly.
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    Command::new("explorer.exe")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_archive(path: String, password: Option<String>) -> Result<Vec<TreeNodeDto>, String> {
    let archive = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        get_handler(&archive)
            .map_err(|e| e.to_string())?
            .list(&archive, password.as_deref())
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
    password: Option<String>,
) -> Result<(), String> {
    let archive = PathBuf::from(path);
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || {
        get_handler(&archive)
            .map_err(|e| e.to_string())?
            .extract(&archive, &dest, password.as_deref(), &mut |p: Progress| {
                let _ = app.emit("extract-progress", ProgressDto::from(p));
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
