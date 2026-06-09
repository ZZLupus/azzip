use std::path::Path;
use std::process::Command;

use super::{ArchiveEntry, ArchiveError, ArchiveHandler, Progress, TreeNode, build_tree, decode_cjk_name};

/// RAR handler — delegates to the system 7-Zip CLI (`7z.exe`).
/// Falls back to common install locations on Windows.
pub struct RarHandler;

const SEVENZIP_PATHS: &[&str] = &[
    "7z",                                          // already in PATH
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
];

fn find_7z() -> Option<String> {
    for &p in SEVENZIP_PATHS {
        if Command::new(p).arg("i").output().is_ok() {
            return Some(p.to_string());
        }
    }
    None
}

fn run_7z(args: &[&str]) -> Result<String, ArchiveError> {
    let bin = find_7z().ok_or_else(|| {
        ArchiveError::Unsupported(
            "未检测到 7-Zip，请安装后重试（https://7-zip.org）".to_string(),
        )
    })?;
    let out = Command::new(&bin)
        .args(args)
        .output()
        .map_err(|e| ArchiveError::Unsupported(e.to_string()))?;
    Ok(decode_cjk_name(&out.stdout))
}

impl ArchiveHandler for RarHandler {
    fn list(&self, archive: &Path, _password: Option<&str>) -> Result<Vec<TreeNode>, ArchiveError> {
        let path_str = archive.to_string_lossy();
        let output = run_7z(&["l", "-ba", "-slt", &path_str])?;

        let mut entries = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_size: u64 = 0;
        let mut current_is_dir = false;

        for line in output.lines() {
            if let Some(rest) = line.strip_prefix("Path = ") {
                current_path = Some(rest.trim().to_string());
                current_size = 0;
                current_is_dir = false;
            } else if let Some(rest) = line.strip_prefix("Size = ") {
                current_size = rest.trim().parse().unwrap_or(0);
            } else if let Some(rest) = line.strip_prefix("Attributes = ") {
                current_is_dir = rest.trim().starts_with('D');
            } else if line.is_empty() {
                if let Some(path) = current_path.take() {
                    let normalized = path.replace('\\', "/");
                    entries.push(ArchiveEntry {
                        path: normalized,
                        size: current_size,
                        is_dir: current_is_dir,
                    });
                }
            }
        }
        // flush last entry if output doesn't end with blank line
        if let Some(path) = current_path {
            let normalized = path.replace('\\', "/");
            entries.push(ArchiveEntry { path: normalized, size: current_size, is_dir: current_is_dir });
        }

        Ok(build_tree(entries))
    }

    fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        password: Option<&str>,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), ArchiveError> {
        // First list to get total count for progress
        let tree = self.list(archive, password)?;
        let total = tree.iter().map(|n| count_files(n)).sum::<usize>();

        let bin = find_7z().ok_or_else(|| {
            ArchiveError::Unsupported(
                "未检测到 7-Zip，请安装后重试（https://7-zip.org）".to_string(),
            )
        })?;

        let path_str = archive.to_string_lossy().into_owned();
        let dest_str = dest.to_string_lossy().into_owned();
        let output_flag = format!("-o{}", dest_str);

        let mut args: Vec<&str> = vec!["x", "-y", &output_flag, &path_str];
        let pw_arg;
        if let Some(pw) = password {
            pw_arg = format!("-p{}", pw);
            args.push(&pw_arg);
        }

        // Emit a start event
        on_progress(Progress { current_file: String::new(), files_done: 0, files_total: total, bytes_done: 0, bytes_total: 0 });

        let status = Command::new(&bin)
            .args(&args)
            .status()
            .map_err(|e| ArchiveError::Unsupported(e.to_string()))?;

        if !status.success() {
            return Err(ArchiveError::InvalidArchive(
                "7-Zip 解压失败".to_string(),
            ));
        }

        // Emit completion
        on_progress(Progress { current_file: String::new(), files_done: total, files_total: total, bytes_done: 0, bytes_total: 0 });
        Ok(())
    }

    fn extract_entry(
        &self,
        archive: &Path,
        entry_path: &str,
        dest_dir: &Path,
        password: Option<&str>,
    ) -> Result<std::path::PathBuf, ArchiveError> {
        let bin = find_7z().ok_or_else(|| {
            ArchiveError::Unsupported("未检测到 7-Zip".to_string())
        })?;
        let path_str = archive.to_string_lossy().into_owned();
        let dest_str = dest_dir.to_string_lossy().into_owned();
        let output_flag = format!("-o{}", dest_str);

        let mut args: Vec<String> = vec![
            "x".into(), "-y".into(), output_flag, path_str, entry_path.to_string(),
        ];
        if let Some(pw) = password {
            args.push(format!("-p{}", pw));
        }

        let status = Command::new(&bin)
            .args(&args)
            .status()
            .map_err(|e| ArchiveError::Unsupported(e.to_string()))?;

        if !status.success() {
            return Err(ArchiveError::InvalidArchive("7-Zip 解压失败".to_string()));
        }

        let top_name = entry_path.split('/').next().unwrap_or(entry_path);
        Ok(dest_dir.join(top_name))
    }
}

fn count_files(node: &TreeNode) -> usize {
    if node.is_dir {
        node.children.iter().map(count_files).sum()
    } else {
        1
    }
}
