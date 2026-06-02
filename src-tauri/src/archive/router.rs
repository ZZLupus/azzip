use std::fs::File;
use std::io::Read;
use std::path::Path;

use super::{ArchiveError, ArchiveHandler};
use super::sevenz::SevenZHandler;
use super::tar::{TarCompression, TarHandler};
use super::zip::ZipHandler;

/// Return the appropriate handler for the given archive path.
/// Strategy: extension-first (fast path), magic-bytes fallback for unknown/missing extensions.
pub fn get_handler(path: &Path) -> Result<Box<dyn ArchiveHandler + Send>, ArchiveError> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Multi-part extensions first (must beat single-extension matches).
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        return Ok(Box::new(TarHandler(TarCompression::Gz)));
    }
    if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") {
        return Ok(Box::new(TarHandler(TarCompression::Bz2)));
    }
    if name.ends_with(".tar.xz") || name.ends_with(".txz") {
        return Ok(Box::new(TarHandler(TarCompression::Xz)));
    }
    if name.ends_with(".tar") {
        return Ok(Box::new(TarHandler(TarCompression::None)));
    }
    if name.ends_with(".zip") {
        return Ok(Box::new(ZipHandler));
    }
    if name.ends_with(".7z") {
        return Ok(Box::new(SevenZHandler));
    }
    if name.ends_with(".gz") {
        return Ok(Box::new(TarHandler(TarCompression::Gz)));
    }
    if name.ends_with(".rar") {
        return Err(ArchiveError::Unsupported(
            "RAR 解压暂不支持，敬请期待".to_string(),
        ));
    }

    // Unknown extension — fall back to magic bytes.
    detect_by_magic(path)
}

fn detect_by_magic(path: &Path) -> Result<Box<dyn ArchiveHandler + Send>, ArchiveError> {
    let mut buf = [0u8; 8];
    let n = File::open(path)?.read(&mut buf)?;
    let header = &buf[..n];

    if header.len() >= 4 && &header[..4] == b"PK\x03\x04" {
        return Ok(Box::new(ZipHandler));
    }
    if header.len() >= 6 && &header[..6] == b"7z\xBC\xAF\x27\x1C" {
        return Ok(Box::new(SevenZHandler));
    }
    if header.len() >= 2 && &header[..2] == b"\x1F\x8B" {
        return Ok(Box::new(TarHandler(TarCompression::Gz)));
    }
    if header.len() >= 3 && &header[..3] == b"BZh" {
        return Ok(Box::new(TarHandler(TarCompression::Bz2)));
    }
    if header.len() >= 6 && &header[..6] == b"\xFD7zXZ\x00" {
        return Ok(Box::new(TarHandler(TarCompression::Xz)));
    }

    Err(ArchiveError::Unsupported(
        "无法识别的文件格式".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_by_extension() {
        let tmp = tempfile::tempdir().unwrap();
        for name in &["a.zip", "a.7z", "a.tar", "a.tar.gz", "a.tgz",
                       "a.tar.bz2", "a.tbz2", "a.tar.xz", "a.txz", "a.gz"] {
            std::fs::write(tmp.path().join(name), b"dummy").unwrap();
        }
        for name in &["a.zip", "a.7z", "a.tar", "a.tar.gz", "a.tgz",
                       "a.tar.bz2", "a.tbz2", "a.tar.xz", "a.txz", "a.gz"] {
            let result = get_handler(&tmp.path().join(name));
            assert!(result.is_ok(), "expected Ok for {name}");
        }
    }

    #[test]
    fn rar_returns_unsupported() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a.rar");
        std::fs::write(&p, b"dummy").unwrap();
        assert!(matches!(get_handler(&p), Err(ArchiveError::Unsupported(_))));
    }

    #[test]
    fn magic_detects_zip_without_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("archive");
        std::fs::write(&p, b"PK\x03\x04xxxxxxxx").unwrap();
        assert!(get_handler(&p).is_ok());
    }

    #[test]
    fn magic_detects_gz_without_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("archive");
        std::fs::write(&p, b"\x1F\x8Bxxxxxxxx").unwrap();
        assert!(get_handler(&p).is_ok());
    }

    #[test]
    fn unknown_returns_unsupported() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("archive");
        std::fs::write(&p, b"totally unknown bytes").unwrap();
        assert!(matches!(get_handler(&p), Err(ArchiveError::Unsupported(_))));
    }
}
