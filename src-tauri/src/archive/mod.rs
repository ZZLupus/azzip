use std::path::Path;
use std::collections::HashMap;

pub mod zip;
pub mod sevenz;
pub mod tar;
pub mod router;

/// One entry inside an archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

/// A node in the archive tree sent to the frontend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

/// Build a tree from flat archive entries.
/// Directories are sorted first, then by name within each level.
pub fn build_tree(entries: Vec<ArchiveEntry>) -> Vec<TreeNode> {
    // Ensure all parent directories exist as explicit nodes.
    let mut all: HashMap<String, TreeNode> = HashMap::new();

    for e in &entries {
        let normalized = e.path.replace('\\', "/");
        let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();

        let mut current_path = String::new();
        for (i, part) in parts.iter().enumerate() {
            if current_path.is_empty() {
                current_path = part.to_string();
            } else {
                current_path = format!("{}/{}", current_path, part);
            }

            let is_last = i == parts.len() - 1;
            let is_dir = !is_last || e.is_dir;
            let size = if is_last && !e.is_dir { e.size } else { 0 };

            all.entry(current_path.clone())
                .and_modify(|node| {
                    if is_last && !e.is_dir {
                        node.size = size;
                        node.is_dir = false;
                    }
                })
                .or_insert(TreeNode {
                    name: part.to_string(),
                    path: current_path.clone(),
                    size,
                    is_dir,
                    children: Vec::new(),
                });
        }
    }

    // Link children to parents. Process deepest paths first so parents
    // are still in the map when their children are attached.
    let mut sorted: Vec<String> = all.keys().cloned().collect();
    sorted.sort();
    sorted.reverse();

    let mut root_nodes: Vec<TreeNode> = Vec::new();

    for path in &sorted {
        let node = all.remove(path).unwrap();
        match path.rfind('/') {
            Some(pos) => {
                let parent_path = &path[..pos];
                if let Some(parent) = all.get_mut(parent_path) {
                    parent.children.push(node);
                } else {
                    root_nodes.push(node);
                }
            }
            None => {
                root_nodes.push(node);
            }
        }
    }

    // Sort each level: directories first, then by name.
    fn sort_children(nodes: &mut [TreeNode]) {
        nodes.sort_by(|a, b| {
            match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.cmp(&b.name),
            }
        });
        for node in nodes.iter_mut() {
            sort_children(&mut node.children);
        }
    }

    sort_children(&mut root_nodes);
    root_nodes
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
    /// List entries and return as a tree.
    fn list(&self, archive: &Path, password: Option<&str>) -> Result<Vec<TreeNode>, ArchiveError>;

    /// Extract all entries to `dest`, invoking `on_progress` per entry.
    fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        password: Option<&str>,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), ArchiveError>;

    /// Extract a single entry (by its in-archive path) to `dest_dir`.
    /// Returns the path of the extracted file/directory on disk.
    fn extract_entry(
        &self,
        archive: &Path,
        entry_path: &str,
        dest_dir: &Path,
        password: Option<&str>,
    ) -> Result<std::path::PathBuf, ArchiveError>;
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

    #[test]
    fn build_tree_nests_children() {
        let entries = vec![
            ArchiveEntry { path: "a/b/c.txt".into(), size: 10, is_dir: false },
            ArchiveEntry { path: "a/d.txt".into(), size: 20, is_dir: false },
            ArchiveEntry { path: "root.txt".into(), size: 5, is_dir: false },
        ];
        let tree = build_tree(entries);
        // Two root nodes: "a/" (dir) and "root.txt" (file), dirs sorted first
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].name, "a");
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].children.len(), 2); // b/ and d.txt
        assert_eq!(tree[1].name, "root.txt");
        assert!(!tree[1].is_dir);
    }

    #[test]
    fn build_tree_sorts_dirs_first() {
        let entries = vec![
            ArchiveEntry { path: "z.txt".into(), size: 1, is_dir: false },
            ArchiveEntry { path: "a/".into(), size: 0, is_dir: true },
        ];
        let tree = build_tree(entries);
        assert_eq!(tree[0].name, "a");
        assert!(tree[0].is_dir);
        assert_eq!(tree[1].name, "z.txt");
        assert!(!tree[1].is_dir);
    }
}
