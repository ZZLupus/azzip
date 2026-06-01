use std::path::Path;

pub mod zip;

/// One entry inside an archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

/// Progress reported during a long operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub current_file: String,
    pub files_done: usize,
    pub files_total: usize,
}

/// Errors any archive engine may return. Human-readable; never a raw code.
#[derive(Debug, thiserror::Error)]
pub enum ArchiveError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("the archive is invalid or corrupt: {0}")]
    InvalidArchive(String),
    #[error("this archive is password-protected")]
    PasswordRequired,
    #[error("the password is incorrect")]
    WrongPassword,
    #[error("unsupported format: {0}")]
    Unsupported(String),
}

/// A handler for one archive format. Future formats implement the same trait
/// (Milestone 2+). `create` / `extract_one` are added in later milestones.
pub trait ArchiveHandler {
    /// List entries without extracting.
    fn list(&self, archive: &Path) -> Result<Vec<ArchiveEntry>, ArchiveError>;

    /// Extract all entries to `dest`, invoking `on_progress` per entry.
    fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), ArchiveError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_entry_constructs() {
        let e = ArchiveEntry { path: "a.txt".into(), size: 3, is_dir: false };
        assert_eq!(e.path, "a.txt");
        assert_eq!(e.size, 3);
        assert!(!e.is_dir);
    }
}
