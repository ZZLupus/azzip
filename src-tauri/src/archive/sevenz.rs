use std::fs;
use std::path::Path;

use super::{ArchiveEntry, ArchiveError, ArchiveHandler, Progress, build_tree, TreeNode};

pub struct SevenZHandler;

fn open_7z(archive: &Path, password: Option<&str>) -> Result<sevenz_rust2::Archive, ArchiveError> {
    if let Some(pw) = password {
        let pw = sevenz_rust2::Password::from(pw);
        sevenz_rust2::Archive::open_with_password(archive, &pw)
            .map_err(|e| {
                let s = e.to_string().to_lowercase();
                if s.contains("password") || s.contains("wrong key") {
                    ArchiveError::WrongPassword
                } else {
                    ArchiveError::InvalidArchive(e.to_string())
                }
            })
    } else {
        sevenz_rust2::Archive::open(archive)
            .map_err(|e| {
                let s = e.to_string().to_lowercase();
                if s.contains("password") || s.contains("encrypted") {
                    ArchiveError::PasswordRequired
                } else {
                    ArchiveError::InvalidArchive(e.to_string())
                }
            })
    }
}

impl ArchiveHandler for SevenZHandler {
    fn list(&self, archive: &Path, password: Option<&str>) -> Result<Vec<TreeNode>, ArchiveError> {
        let arc = open_7z(archive, password)?;
        let entries: Vec<ArchiveEntry> = arc.files.iter().map(|e| ArchiveEntry {
            path: e.name.clone(),
            size: e.size,
            is_dir: e.is_directory,
        }).collect();
        Ok(build_tree(entries))
    }

    fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        password: Option<&str>,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), ArchiveError> {
        let arc = open_7z(archive, password)?;
        let total = arc.files.len();

        fs::create_dir_all(dest)?;

        let pw = sevenz_rust2::Password::from(password.unwrap_or(""));
        let file = fs::File::open(archive)?;
        let mut files_done = 0usize;

        sevenz_rust2::decompress_with_extract_fn_and_password(
            file,
            dest,
            pw,
            |entry: &sevenz_rust2::ArchiveEntry, reader, dest_path| {
                // Report progress before extracting this entry
                on_progress(Progress {
                    current_file: entry.name.clone(),
                    files_done,
                    files_total: total,
                    bytes_done: 0, bytes_total: 0,
                });
                files_done += 1;
                // Return true to let the library perform the actual extraction
                sevenz_rust2::default_entry_extract_fn(entry, reader, dest_path)
            },
        )
        .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;

        // Final completion signal
        on_progress(Progress {
            current_file: String::new(),
            files_done: total,
            files_total: total,
            bytes_done: 0, bytes_total: 0,
        });
        Ok(())
    }

    fn extract_entry(
        &self,
        archive: &Path,
        entry_path: &str,
        dest_dir: &Path,
        password: Option<&str>,
    ) -> Result<std::path::PathBuf, ArchiveError> {
        // 7z has no per-entry API; extract all to a temp dir, then move the target.
        let tmp = std::env::temp_dir().join(format!("azzip_7z_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));
        let pw = sevenz_rust2::Password::from(password.unwrap_or(""));
        sevenz_rust2::decompress_file_with_password(archive, &tmp, pw)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;

        let src = tmp.join(entry_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !src.exists() {
            let _ = fs::remove_dir_all(&tmp);
            return Err(ArchiveError::InvalidArchive(format!("entry '{}' not found", entry_path)));
        }

        fs::create_dir_all(dest_dir)?;
        let top_name = entry_path.split('/').next().unwrap_or(entry_path);
        let dest = dest_dir.join(top_name);
        if src.is_dir() {
            copy_dir_all(&src, &dest)?;
        } else {
            fs::copy(&src, &dest)?;
        }
        let _ = fs::remove_dir_all(&tmp);
        Ok(dest)
    }
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), ArchiveError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn has_file(dir: &Path, name: &str) -> bool {
        if let Ok(rd) = fs::read_dir(dir) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.file_name().and_then(|n| n.to_str()) == Some(name) {
                    return true;
                }
                if p.is_dir() && has_file(&p, name) {
                    return true;
                }
            }
        }
        false
    }

    fn make_test_7z(dir: &Path) -> std::path::PathBuf {
        let out = dir.join("test.7z");
        let src_dir = dir.join("src");
        fs::create_dir_all(src_dir.join("docs")).unwrap();
        fs::write(src_dir.join("docs/readme.txt"), b"hello 7z").unwrap();
        fs::write(src_dir.join("root.txt"), b"top").unwrap();
        sevenz_rust2::compress_to_path(&src_dir, &out)
            .expect("failed to create test .7z");
        out
    }

    #[test]
    fn list_returns_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_7z(tmp.path());
        let tree = SevenZHandler.list(&archive, None).unwrap();
        assert!(!tree.is_empty());
    }

    #[test]
    fn extract_writes_files() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_7z(tmp.path());
        let dest = tmp.path().join("out");
        let mut events: Vec<Progress> = Vec::new();
        SevenZHandler.extract(&archive, &dest, None, &mut |p| events.push(p)).unwrap();
        assert!(has_file(&dest, "readme.txt"));
        assert!(has_file(&dest, "root.txt"));
        assert!(!events.is_empty());
    }

    #[test]
    fn list_corrupt_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.7z");
        fs::write(&bad, b"not a 7z file").unwrap();
        let err = SevenZHandler.list(&bad, None).unwrap_err();
        assert!(matches!(err, ArchiveError::InvalidArchive(_)));
    }
}
