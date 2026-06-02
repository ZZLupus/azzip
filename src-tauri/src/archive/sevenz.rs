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
        let names: Vec<String> = arc.files.iter().map(|e| e.name.clone()).collect();
        let total = names.len();

        fs::create_dir_all(dest)?;
        let pw = sevenz_rust2::Password::from(password.unwrap_or(""));
        sevenz_rust2::decompress_file_with_password(archive, dest, pw)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;

        // Emit synthetic progress after extraction completes.
        for (i, name) in names.iter().enumerate() {
            on_progress(Progress {
                current_file: name.clone(),
                files_done: i + 1,
                files_total: total,
            });
        }
        if total == 0 {
            on_progress(Progress {
                current_file: String::new(),
                files_done: 0,
                files_total: 0,
            });
        }
        Ok(())
    }
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
