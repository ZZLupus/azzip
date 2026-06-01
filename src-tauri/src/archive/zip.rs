use std::fs::{self, File};
use std::io;
use std::path::Path;

use ::zip::ZipArchive;

use super::{ArchiveEntry, ArchiveError, ArchiveHandler, Progress, TreeNode, build_tree};

pub struct ZipHandler;

impl ArchiveHandler for ZipHandler {
    fn list(&self, archive: &Path) -> Result<Vec<TreeNode>, ArchiveError> {
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
        Ok(build_tree(entries))
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
            // Capture the name before the write block to avoid borrow-checker issues
            // with `&mut entry` passed to `io::copy`.
            let name = entry.name().to_string();

            if entry.is_dir() {
                fs::create_dir_all(&out_path)?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut out = File::create(&out_path)?;
                io::copy(&mut entry, &mut out)?;
            }

            on_progress(Progress {
                current_file: name,
                files_done: i + 1,
                files_total: total,
            });
        }
        // Only needed so empty archives still emit a completion signal.
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
        let tree = ZipHandler.list(&archive).unwrap();

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
            .extract(&archive, &dest, &mut |p| events.push(p))
            .unwrap();

        assert_eq!(
            fs::read_to_string(dest.join("docs/readme.txt")).unwrap(),
            "hello azzip"
        );
        assert_eq!(
            fs::read_to_string(dest.join("root.txt")).unwrap(),
            "top level"
        );

        // 3 entries -> 3 progress events, files_done counts 1,2,3 and total stays 3
        assert_eq!(events.len(), 3);
        for (idx, ev) in events.iter().enumerate() {
            assert_eq!(ev.files_done, idx + 1);
            assert_eq!(ev.files_total, 3);
        }
        // final event signals completion
        let last = events.last().unwrap();
        assert_eq!(last.files_done, last.files_total);
    }

    #[test]
    fn list_corrupt_returns_invalid_archive() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.zip");
        fs::write(&bad, b"this is not a zip file").unwrap();
        let err = ZipHandler.list(&bad).unwrap_err();
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
            .extract(&path, &dest, &mut |p| events.push(p))
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
        let listed = ZipHandler.list(&path).unwrap();
        let has_traversal = listed.iter().any(|n| n.path.contains("..") || n.children.iter().any(|c| c.path.contains("..")));
        assert!(
            has_traversal,
            "fixture should contain a traversal path"
        );

        // extract must refuse the traversal entry.
        let dest = tmp.path().join("out");
        let err = ZipHandler.extract(&path, &dest, &mut |_| {}).unwrap_err();
        assert!(matches!(err, ArchiveError::InvalidArchive(_)));

        // And nothing must have escaped above `dest`.
        assert!(!tmp.path().join("evil.txt").exists());
    }
}
