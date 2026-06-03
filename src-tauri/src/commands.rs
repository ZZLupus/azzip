use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::archive::{Progress, TreeNode};
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
    pub bytes_done: u64,
    pub bytes_total: u64,
}

impl From<Progress> for ProgressDto {
    fn from(p: Progress) -> Self {
        ProgressDto {
            current_file: p.current_file,
            files_done: p.files_done,
            files_total: p.files_total,
            bytes_done: p.bytes_done,
            bytes_total: p.bytes_total,
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

/// Compress progress payload.
#[derive(Serialize, Clone)]
pub struct CompressProgressDto {
    pub current_file: String,
    pub files_done: usize,
    pub files_total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

const SEVENZIP_PATHS: &[&str] = &[
    "7z",
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
];

fn find_7z() -> Result<String, String> {
    SEVENZIP_PATHS
        .iter()
        .find(|&p| Command::new(p).arg("i").output().is_ok())
        .map(|s| s.to_string())
        .ok_or_else(|| "未检测到 7-Zip，请安装后重试（https://7-zip.org）".to_string())
}

/// Count total files and total bytes in source paths (directories walked recursively).
fn count_compress_total(sources: &[PathBuf]) -> (usize, u64) {
    fn walk(p: &Path) -> (usize, u64) {
        if p.is_file() {
            let sz = p.metadata().map(|m| m.len()).unwrap_or(0);
            return (1, sz);
        }
        if let Ok(entries) = fs::read_dir(p) {
            entries.filter_map(|e| e.ok()).map(|e| walk(&e.path())).fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1))
        } else { (0, 0) }
    }
    sources.iter().map(|p| walk(p)).fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1))
}

/// Create a new archive. ZIP uses native Rust `zip` crate (no subprocess, real progress).
/// 7z and password-protected ZIP fall back to system 7-Zip CLI.
#[tauri::command]
pub async fn compress_files(
    app: AppHandle,
    sources: Vec<String>,
    dest: String,
    format: String,
    level: Option<u32>,
    password: Option<String>,
) -> Result<(), String> {
    let src_paths: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    let (total_files, total_bytes) = count_compress_total(&src_paths);
    let lvl = level.unwrap_or(5).clamp(1, 9);

    let archive_arg = if dest.ends_with(&format!(".{}", format)) {
        dest.clone()
    } else {
        format!("{}.{}", dest, format)
    };

    // Emit start
    let _ = app.emit("compress-progress", CompressProgressDto {
        current_file: String::new(), files_done: 0, files_total: total_files,
        bytes_done: 0, bytes_total: total_bytes,
    });

    // ZIP without password → native Rust, real file-by-file progress
    if format == "zip" && password.is_none() {
        let dest_path = PathBuf::from(&archive_arg);
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            compress_zip_native(&app2, &src_paths, &dest_path, lvl, total_files, total_bytes)
        })
        .await
        .map_err(|e| e.to_string())??;
    } else {
        // 7z or password-protected ZIP → system 7-Zip CLI
        let bin = find_7z()?;
        let mut args: Vec<String> = vec![
            "a".into(), "-y".into(),
            format!("-t{}", format),
            format!("-mx{}", lvl),
        ];
        if let Some(ref pw) = password {
            args.push(format!("-p{}", pw));
        }
        args.push(archive_arg.clone());
        for s in &src_paths {
            args.push(s.to_string_lossy().into_owned());
        }

        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut cmd = Command::new(&bin);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let status = cmd.args(&args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("压缩失败".to_string());
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
    }

    // Emit completion
    let _ = app.emit("compress-progress", CompressProgressDto {
        current_file: String::new(), files_done: total_files, files_total: total_files,
        bytes_done: total_bytes, bytes_total: total_bytes,
    });

    Ok(())
}

/// Progress-tracking reader — wraps a file and emits byte-level progress events.
struct ProgressReader<'a> {
    inner: File,
    app: &'a AppHandle,
    current_file: String,
    bytes_done: &'a mut u64,
    bytes_total: u64,
    files_done: usize,
    files_total: usize,
    last_emit: std::time::Instant,
}

impl<'a> io::Read for ProgressReader<'a> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        *self.bytes_done += n as u64;
        // Emit progress every ~100ms or at file boundaries
        let now = std::time::Instant::now();
        if now.duration_since(self.last_emit) > std::time::Duration::from_millis(100) || n == 0 {
            let _ = self.app.emit("compress-progress", CompressProgressDto {
                current_file: self.current_file.clone(),
                files_done: self.files_done,
                files_total: self.files_total,
                bytes_done: *self.bytes_done,
                bytes_total: self.bytes_total,
            });
            self.last_emit = now;
        }
        Ok(n)
    }
}

/// Native ZIP compression using the `zip` crate. Emits byte-level progress.
fn compress_zip_native(
    app: &AppHandle,
    src_paths: &[PathBuf],
    dest: &Path,
    _level: u32,
    total_files: usize,
    total_bytes: u64,
) -> Result<(), String> {
    let file = File::create(dest).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let mut bytes_done: u64 = 0;
    let mut files_done: usize = 0;

    fn walk(
        zip: &mut ZipWriter<File>,
        src: &Path,
        prefix: &str,
        app: &AppHandle,
        bytes_done: &mut u64,
        total_bytes: u64,
        files_done: &mut usize,
        total_files: usize,
    ) -> Result<(), String> {
        if src.is_file() {
            let rel = if prefix.is_empty() {
                src.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string()
            } else {
                format!("{}/{}", prefix, src.file_name().and_then(|n| n.to_str()).unwrap_or("unknown"))
            };
            let options = SimpleFileOptions::default();
            zip.start_file(&rel, options).map_err(|e| e.to_string())?;
            let f = File::open(src).map_err(|e| e.to_string())?;
            let mut reader = ProgressReader {
                inner: f,
                app,
                current_file: rel.clone(),
                bytes_done,
                bytes_total: total_bytes,
                files_done: *files_done,
                files_total: total_files,
                last_emit: std::time::Instant::now(),
            };
            io::copy(&mut reader, zip).map_err(|e| e.to_string())?;
            *files_done += 1;
            // Emit at file boundary
            let _ = app.emit("compress-progress", CompressProgressDto {
                current_file: rel,
                files_done: *files_done,
                files_total: total_files,
                bytes_done: *bytes_done,
                bytes_total: total_bytes,
            });
        } else if src.is_dir() {
            let dir_name = src.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let new_prefix = if prefix.is_empty() { dir_name.to_string() } else { format!("{}/{}", prefix, dir_name) };
            let options = SimpleFileOptions::default();
            zip.add_directory(&new_prefix, options).map_err(|e| e.to_string())?;
            let entries = fs::read_dir(src).map_err(|e| e.to_string())?;
            for entry in entries {
                let entry = entry.map_err(|e| e.to_string())?;
                walk(zip, &entry.path(), &new_prefix, app, bytes_done, total_bytes, files_done, total_files)?;
            }
        }
        Ok(())
    }

    for src in src_paths {
        walk(&mut zip, src, "", app, &mut bytes_done, total_bytes, &mut files_done, total_files)?;
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}
