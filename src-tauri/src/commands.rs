use std::path::PathBuf;

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

#[tauri::command]
pub async fn list_archive(path: String) -> Result<Vec<TreeNodeDto>, String> {
    let archive = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        get_handler(&archive)
            .map_err(|e| e.to_string())?
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
        get_handler(&archive)
            .map_err(|e| e.to_string())?
            .extract(&archive, &dest, &mut |p: Progress| {
                let _ = app.emit("extract-progress", ProgressDto::from(p));
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
