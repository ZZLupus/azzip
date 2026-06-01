use std::fs::{self, File};
use std::io;
use std::path::Path;

use ::zip::ZipArchive;

use super::{ArchiveEntry, ArchiveError, ArchiveHandler, Progress};

pub struct ZipHandler;

impl ArchiveHandler for ZipHandler {
    fn list(&self, archive: &Path) -> Result<Vec<ArchiveEntry>, ArchiveError> {
        let file = File::open(archive)?;
        let mut zip = ZipArchive::new(file)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let mut entries = Vec::with_capacity(zip.len());
        for i in 0..zip.len() {
            let f = zip.by_index(i)
                .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
            entries.push(ArchiveEntry {
                path: f.name().to_string(),
                size: f.size(),
                is_dir: f.is_dir(),
            });
        }
        Ok(entries)
    }

    fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), ArchiveError> {
        let file = File::open(archive)?;
        let mut zip = ZipArchive::new(file)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let total = zip.len();
        for i in 0..total {
            let mut entry = zip.by_index(i)
                .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
            let rel = entry.enclosed_name()
                .ok_or_else(|| ArchiveError::InvalidArchive(
                    "entry has an unsafe path".into()))?;
            let out_path = dest.join(rel);

            on_progress(Progress {
                current_file: entry.name().to_string(),
                files_done: i,
                files_total: total,
            });

            if entry.is_dir() {
                fs::create_dir_all(&out_path)?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut out = File::create(&out_path)?;
                io::copy(&mut entry, &mut out)?;
            }
        }
        on_progress(Progress {
            current_file: String::new(),
            files_done: total,
            files_total: total,
        });
        Ok(())
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
        let entries = ZipHandler.list(&archive).unwrap();

        let readme = entries.iter().find(|e| e.path == "docs/readme.txt").unwrap();
        assert_eq!(readme.size, 11);
        assert!(!readme.is_dir);
        assert!(entries.iter().any(|e| e.path == "docs/" && e.is_dir));
        assert!(entries.iter().any(|e| e.path == "root.txt"));
    }

    #[test]
    fn extract_writes_files_and_reports_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_zip(tmp.path());
        let dest = tmp.path().join("out");

        let mut last = Progress { current_file: "x".into(), files_done: 0, files_total: 0 };
        ZipHandler
            .extract(&archive, &dest, &mut |p| last = p)
            .unwrap();

        assert_eq!(
            fs::read_to_string(dest.join("docs/readme.txt")).unwrap(),
            "hello azzip"
        );
        assert_eq!(
            fs::read_to_string(dest.join("root.txt")).unwrap(),
            "top level"
        );
        // final progress callback signals completion
        assert_eq!(last.files_done, last.files_total);
        assert!(last.files_total >= 2);
    }

    #[test]
    fn list_corrupt_returns_invalid_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.zip");
        fs::write(&bad, b"this is not a zip file").unwrap();
        let err = ZipHandler.list(&bad).unwrap_err();
        assert!(matches!(err, ArchiveError::InvalidArchive(_)));
    }
}
