use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;
use std::time::Instant;

use ::zip::{ZipArchive, result::ZipError};

use super::{ArchiveEntry, ArchiveError, ArchiveHandler, Progress, TreeNode, build_tree, decode_cjk_name};

fn decode_zip_path(raw: &[u8]) -> Option<std::path::PathBuf> {
    let name = decode_cjk_name(raw);
    let path = std::path::Path::new(&name);
    for component in path.components() {
        if let std::path::Component::ParentDir = component {
            return None;
        }
    }
    let rel = path.strip_prefix("/").unwrap_or(path);
    let rel = rel.strip_prefix("\\").unwrap_or(rel);
    Some(rel.to_path_buf())
}

/// Progress-tracking buffered writer — emits byte-level progress during extraction.
/// Uses a 256KB BufWriter to minimize syscalls and checks elapsed time every 64 writes.
struct ProgWriter<'a> {
    inner: BufWriter<File>,
    done: &'a mut u64,
    total: u64,
    current_file: String,
    files_done: usize,
    files_total: usize,
    cb: &'a mut dyn FnMut(Progress),
    last_emit: Instant,
    tick: u8,
}

impl<'a> Write for ProgWriter<'a> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        *self.done += n as u64;
        self.tick = self.tick.wrapping_add(1);
        if self.tick == 0 {
            let now = Instant::now();
            if now.duration_since(self.last_emit) > std::time::Duration::from_millis(100) || n == 0 {
                (self.cb)(Progress {
                    current_file: self.current_file.clone(),
                    files_done: self.files_done,
                    files_total: self.files_total,
                    bytes_done: *self.done,
                    bytes_total: self.total,
                });
                self.last_emit = now;
            }
        }
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> { self.inner.flush() }
}

impl<'a> Drop for ProgWriter<'a> {
    fn drop(&mut self) {
        let _ = self.inner.flush();
    }
}

const COPY_BUF_KB: usize = 512;

pub struct ZipHandler;

fn map_zip_err(e: ZipError) -> ArchiveError {
    match e {
        ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) => ArchiveError::PasswordRequired,
        ZipError::InvalidPassword => ArchiveError::WrongPassword,
        other => ArchiveError::InvalidArchive(other.to_string()),
    }
}

impl ArchiveHandler for ZipHandler {
    fn list(&self, archive: &Path, password: Option<&str>) -> Result<Vec<TreeNode>, ArchiveError> {
        let file = File::open(archive)?;
        let mut zip = ZipArchive::new(file)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let mut entries = Vec::with_capacity(zip.len());
        for i in 0..zip.len() {
            let f = match password {
                Some(pw) => zip.by_index_decrypt(i, pw.as_bytes())
                    .map_err(map_zip_err)?,
                None => zip.by_index(i).map_err(map_zip_err)?,
            };
            entries.push(ArchiveEntry {
                path: decode_cjk_name(f.name_raw()),
                size: f.size(),
                is_dir: f.is_dir(),
            });
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
        let file = File::open(archive)?;
        let mut zip = ZipArchive::new(file)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;

        let total_files = zip.len();
        let mut total_bytes: u64 = 0;
        for i in 0..total_files {
            if let Ok(entry) = zip.by_index(i) {
                total_bytes += entry.size();
            }
        }

        let mut global_bytes_done: u64 = 0;

        for i in 0..total_files {
            let mut entry = match password {
                Some(pw) => zip.by_index_decrypt(i, pw.as_bytes())
                    .map_err(map_zip_err)?,
                None => zip.by_index(i).map_err(map_zip_err)?,
            };
            let rel = decode_zip_path(entry.name_raw())
                .ok_or_else(|| ArchiveError::InvalidArchive(
                    "entry has an unsafe path".into()))?;
            let out_path = dest.join(rel);
            let name = decode_cjk_name(entry.name_raw());

            if entry.is_dir() {
                fs::create_dir_all(&out_path)?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let out = File::create(&out_path)?;
                let mut writer = ProgWriter {
                    inner: BufWriter::with_capacity(256 * 1024, out),
                    done: &mut global_bytes_done,
                    total: total_bytes,
                    current_file: name.clone(),
                    files_done: i,
                    files_total: total_files,
                    cb: on_progress,
                    last_emit: Instant::now() - std::time::Duration::from_secs(10),
                    tick: 0,
                };
                let mut buf = vec![0u8; COPY_BUF_KB * 1024];
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 { break; }
                    writer.write_all(&buf[..n])?;
                }
                writer.flush()?;
            }

            // Emit at file boundary even if less than 100ms
            on_progress(Progress {
                current_file: name,
                files_done: i + 1,
                files_total: total_files,
                bytes_done: global_bytes_done,
                bytes_total: total_bytes,
            });
        }
        if total_files == 0 {
            on_progress(Progress {
                current_file: String::new(),
                files_done: 0,
                files_total: 0,
                bytes_done: 0, bytes_total: 0,
            });
        }
        Ok(())
    }

    fn extract_entry(
        &self,
        archive: &Path,
        entry_path: &str,
        dest_dir: &Path,
        password: Option<&str>,
    ) -> Result<std::path::PathBuf, ArchiveError> {
        let file = File::open(archive)?;
        let mut zip = ZipArchive::new(file)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;

        // Find all entries whose path starts with entry_path (handles directories).
        let indices: Vec<usize> = (0..zip.len())
            .filter(|&i| {
                zip.by_index_raw(i)
                    .ok()
                    .map(|e| {
                        let n = decode_cjk_name(e.name_raw());
                        n == entry_path || n.starts_with(&format!("{}/", entry_path))
                    })
                    .unwrap_or(false)
            })
            .collect();

        if indices.is_empty() {
            return Err(ArchiveError::InvalidArchive(
                format!("entry '{}' not found", entry_path),
            ));
        }

        fs::create_dir_all(dest_dir)?;

        for i in indices {
            let mut entry = match password {
                Some(pw) => zip.by_index_decrypt(i, pw.as_bytes()).map_err(map_zip_err)?,
                None => zip.by_index(i).map_err(map_zip_err)?,
            };
            let rel = decode_zip_path(entry.name_raw())
                .ok_or_else(|| ArchiveError::InvalidArchive("unsafe path".into()))?;
            let out = dest_dir.join(&rel);
            if entry.is_dir() {
                fs::create_dir_all(&out)?;
            } else {
                if let Some(p) = out.parent() { fs::create_dir_all(p)?; }
                let f = File::create(&out)?;
                let mut writer = BufWriter::with_capacity(256 * 1024, f);
                let mut buf = vec![0u8; COPY_BUF_KB * 1024];
                loop {
                    let n = entry.read(&mut buf)?;
                    if n == 0 { break; }
                    writer.write_all(&buf[..n])?;
                }
                writer.flush()?;
            }
        }

        // Return the top-level item inside dest_dir.
        let top = {
            let parts: Vec<&str> = entry_path.split('/').collect();
            dest_dir.join(parts[0])
        };
        Ok(top)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use ::zip::write::SimpleFileOptions;
    use ::zip::ZipWriter;

    /// Build a small in-memory-ish zip on disk for tests.
    fn make_test_zip(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("test.zip");
        let file = File::create(&path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opts = SimpleFileOptions::default();
        zip.add_directory("docs/", opts).unwrap();
        zip.start_file("docs/readme.txt", opts).unwrap();
        zip.write_all(b"hello azzip").unwrap();
        zip.start_file("root.txt", opts).unwrap();
        zip.write_all(b"top level").unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn list_returns_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_zip(tmp.path());
        let tree = ZipHandler.list(&archive, None).unwrap();

        // Should have root.txt + docs/ at top level
        assert_eq!(tree.len(), 2);
        // First should be docs/ (dirs first)
        assert_eq!(tree[0].name, "docs");
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].name, "readme.txt");
        assert_eq!(tree[0].children[0].size, 11);
        // root.txt
        assert_eq!(tree[1].name, "root.txt");
        assert!(!tree[1].is_dir);
    }

    #[test]
    fn extract_writes_files_and_reports_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_zip(tmp.path());
        let dest = tmp.path().join("out");

        let mut events: Vec<Progress> = Vec::new();
        ZipHandler
            .extract(&archive, &dest, None, &mut |p| events.push(p))
            .unwrap();

        assert_eq!(
            fs::read_to_string(dest.join("docs/readme.txt")).unwrap(),
            "hello azzip"
        );
        assert_eq!(
            fs::read_to_string(dest.join("root.txt")).unwrap(),
            "top level"
        );

        // Verify final event signals completion
        let last = events.last().unwrap();
        assert_eq!(last.files_done, last.files_total);
        assert_eq!(last.files_total, 3);
        // files_done progresses from 0→1→2→3 across boundary events
        let done_vals: Vec<usize> = events.iter().map(|e| e.files_done).collect();
        assert!(done_vals.contains(&1));
        assert!(done_vals.contains(&2));
        assert!(done_vals.contains(&3));
    }

    #[test]
    fn list_corrupt_returns_invalid_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.zip");
        fs::write(&bad, b"this is not a zip file").unwrap();
        let err = ZipHandler.list(&bad, None).unwrap_err();
        assert!(matches!(err, ArchiveError::InvalidArchive(_)));
    }

    #[test]
    fn extract_empty_archive_reports_completion() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("empty.zip");
        {
            let file = File::create(&path).unwrap();
            let zip = ZipWriter::new(file);
            zip.finish().unwrap();
        }
        let dest = tmp.path().join("out");

        let mut events: Vec<Progress> = Vec::new();
        ZipHandler
            .extract(&path, &dest, None, &mut |p| events.push(p))
            .unwrap();

        // empty archive still emits exactly one completion event (0 of 0)
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].files_done, 0);
        assert_eq!(events[0].files_total, 0);
    }

    #[test]
    fn extract_rejects_zip_slip_path() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("malicious.zip");
        {
            let file = File::create(&path).unwrap();
            let mut zip = ZipWriter::new(file);
            zip.start_file("../evil.txt", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"should not land here").unwrap();
            zip.finish().unwrap();
        }

        // Sanity-check the fixture actually contains a traversal path.
        let listed = ZipHandler.list(&path, None).unwrap();
        let has_traversal = listed.iter().any(|n| n.path.contains("..") || n.children.iter().any(|c| c.path.contains("..")));
        assert!(
            has_traversal,
            "fixture should contain a traversal path"
        );

        // extract must refuse the traversal entry.
        let dest = tmp.path().join("out");
        let err = ZipHandler.extract(&path, &dest, None, &mut |_| {}).unwrap_err();
        assert!(matches!(err, ArchiveError::InvalidArchive(_)));

        // And nothing must have escaped above `dest`.
        assert!(!tmp.path().join("evil.txt").exists());
    }
}
