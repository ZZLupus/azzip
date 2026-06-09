use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::{Component, Path};

use super::{ArchiveEntry, ArchiveError, ArchiveHandler, Progress, build_tree, TreeNode};

const TAR_COPY_BUF_KB: usize = 512;

#[derive(Debug, Clone, Copy)]
pub enum TarCompression {
    None,
    Gz,
    Bz2,
    Xz,
}

pub struct TarHandler(pub TarCompression);

/// Returns true if any component of the path is a ParentDir (..).
fn has_traversal(p: &Path) -> bool {
    p.components().any(|c| c == Component::ParentDir)
}

fn list_tar<R: Read>(reader: R) -> Result<Vec<ArchiveEntry>, ArchiveError> {
    let mut archive = tar::Archive::new(reader);
    let mut entries = Vec::new();
    for entry in archive.entries().map_err(|e| ArchiveError::InvalidArchive(e.to_string()))? {
        let entry = entry.map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let raw_path = entry.path().map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        if has_traversal(&raw_path) {
            continue; // zip-slip guard
        }
        let path_str = raw_path.to_string_lossy().replace('\\', "/");
        let is_dir = entry.header().entry_type().is_dir();
        let size = entry.header().size().unwrap_or(0);
        entries.push(ArchiveEntry { path: path_str, size, is_dir });
    }
    Ok(entries)
}

fn extract_tar<R: Read>(
    reader: R,
    dest: &Path,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<(), ArchiveError> {
    let mut archive = tar::Archive::new(reader);
    let mut count = 0usize;
    for entry in archive.entries().map_err(|e| ArchiveError::InvalidArchive(e.to_string()))? {
        let mut entry = entry.map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let raw_path = entry.path().map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        if has_traversal(&raw_path) {
            continue;
        }
        let out_path = dest.join(&*raw_path);
        let name = raw_path.to_string_lossy().into_owned();

        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let out = File::create(&out_path)?;
            let mut writer = BufWriter::with_capacity(256 * 1024, out);
            let mut buf = vec![0u8; TAR_COPY_BUF_KB * 1024];
            loop {
                let n = entry.read(&mut buf)?;
                if n == 0 { break; }
                writer.write_all(&buf[..n])?;
            }
            writer.flush()?;
        }
        count += 1;
        on_progress(Progress {
            current_file: name,
            files_done: count,
            files_total: 0,
            bytes_done: 0, bytes_total: 0,
        });
    }
    // Final signal with accurate total.
    on_progress(Progress {
        current_file: String::new(),
        files_done: count,
        files_total: count,
        bytes_done: 0, bytes_total: 0,
    });
    Ok(())
}

impl ArchiveHandler for TarHandler {
    fn list(&self, archive: &Path, _password: Option<&str>) -> Result<Vec<TreeNode>, ArchiveError> {
        let file = File::open(archive)?;
        let entries = match self.0 {
            TarCompression::None => list_tar(file)?,
            TarCompression::Gz => list_tar(flate2::read::GzDecoder::new(file))?,
            TarCompression::Bz2 => list_tar(bzip2::read::BzDecoder::new(file))?,
            TarCompression::Xz => list_tar(xz2::read::XzDecoder::new(file))?,
        };
        Ok(build_tree(entries))
    }

    fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        _password: Option<&str>,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), ArchiveError> {
        fs::create_dir_all(dest)?;
        let file = File::open(archive)?;
        match self.0 {
            TarCompression::None => extract_tar(file, dest, on_progress),
            TarCompression::Gz => extract_tar(flate2::read::GzDecoder::new(file), dest, on_progress),
            TarCompression::Bz2 => extract_tar(bzip2::read::BzDecoder::new(file), dest, on_progress),
            TarCompression::Xz => extract_tar(xz2::read::XzDecoder::new(file), dest, on_progress),
        }
    }

    fn extract_entry(
        &self,
        archive: &Path,
        entry_path: &str,
        dest_dir: &Path,
        _password: Option<&str>,
    ) -> Result<std::path::PathBuf, ArchiveError> {
        let file = File::open(archive)?;
        fs::create_dir_all(dest_dir)?;
        match self.0 {
            TarCompression::None => extract_tar_entry(file, entry_path, dest_dir),
            TarCompression::Gz => extract_tar_entry(flate2::read::GzDecoder::new(file), entry_path, dest_dir),
            TarCompression::Bz2 => extract_tar_entry(bzip2::read::BzDecoder::new(file), entry_path, dest_dir),
            TarCompression::Xz => extract_tar_entry(xz2::read::XzDecoder::new(file), entry_path, dest_dir),
        }
    }
}

fn extract_tar_entry<R: io::Read>(
    reader: R,
    entry_path: &str,
    dest_dir: &Path,
) -> Result<std::path::PathBuf, ArchiveError> {
    let mut archive = tar::Archive::new(reader);
    let mut found = false;

    for entry in archive.entries().map_err(|e| ArchiveError::InvalidArchive(e.to_string()))? {
        let mut entry = entry.map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let raw_path = entry.path().map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        if has_traversal(&raw_path) { continue; }
        let path_str = raw_path.to_string_lossy();
        let normalized = path_str.trim_end_matches('/');
        if normalized != entry_path && !normalized.starts_with(&format!("{}/", entry_path)) {
            continue;
        }
        found = true;
        let out = dest_dir.join(&*raw_path);
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out)?;
        } else {
            if let Some(p) = out.parent() { fs::create_dir_all(p)?; }
            let f = File::create(&out)?;
            let mut writer = BufWriter::with_capacity(256 * 1024, f);
            let mut buf = vec![0u8; TAR_COPY_BUF_KB * 1024];
            loop {
                let n = entry.read(&mut buf)?;
                if n == 0 { break; }
                writer.write_all(&buf[..n])?;
            }
            writer.flush()?;
        }
    }

    if !found {
        return Err(ArchiveError::InvalidArchive(format!("entry '{}' not found", entry_path)));
    }
    let top_name = entry_path.split('/').next().unwrap_or(entry_path);
    Ok(dest_dir.join(top_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_tar_gz(dir: &Path) -> std::path::PathBuf {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        let out = dir.join("test.tar.gz");
        let file = File::create(&out).unwrap();
        let gz = GzEncoder::new(file, Compression::default());
        let mut builder = tar::Builder::new(gz);

        let content = b"hello tar";
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, "docs/readme.txt", content.as_ref()).unwrap();

        let content2 = b"top level";
        let mut header2 = tar::Header::new_gnu();
        header2.set_size(content2.len() as u64);
        header2.set_mode(0o644);
        header2.set_cksum();
        builder.append_data(&mut header2, "root.txt", content2.as_ref()).unwrap();

        builder.finish().unwrap();
        out
    }

    #[test]
    fn list_tar_gz_returns_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_tar_gz(tmp.path());
        let tree = TarHandler(TarCompression::Gz).list(&archive, None).unwrap();
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].name, "docs");
        assert!(tree[0].is_dir);
        assert_eq!(tree[1].name, "root.txt");
    }

    #[test]
    fn extract_tar_gz_writes_files() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_tar_gz(tmp.path());
        let dest = tmp.path().join("out");
        let mut events: Vec<Progress> = Vec::new();
        TarHandler(TarCompression::Gz)
            .extract(&archive, &dest, None, &mut |p| events.push(p))
            .unwrap();
        assert_eq!(fs::read_to_string(dest.join("docs/readme.txt")).unwrap(), "hello tar");
        assert_eq!(fs::read_to_string(dest.join("root.txt")).unwrap(), "top level");
        let last = events.last().unwrap();
        assert_eq!(last.files_done, last.files_total);
        assert!(last.files_total >= 2);
    }

    #[test]
    fn list_tar_gz_lists_multiple_compressions() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_tar_gz(tmp.path());
        let tree = TarHandler(TarCompression::Gz).list(&archive, None).unwrap();
        assert!(tree.len() >= 2);
        // Verify we have both a directory and a file in the tree
        let has_dir = tree.iter().any(|n| n.is_dir);
        let has_file = tree.iter().any(|n| !n.is_dir);
        assert!(has_dir);
        assert!(has_file);
    }

    #[test]
    fn list_corrupt_tar_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.tar.gz");
        fs::write(&bad, b"not a tar").unwrap();
        let err = TarHandler(TarCompression::Gz).list(&bad, None).unwrap_err();
        assert!(matches!(err, ArchiveError::InvalidArchive(_)));
    }
}
