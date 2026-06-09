use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
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

/// Minimum number of files to consider multi-threaded extraction.
const PARALLEL_MIN_FILES: usize = 4;
/// Minimum uncompressed bytes to consider multi-threaded extraction.
const PARALLEL_MIN_BYTES: u64 = 10 * 1024 * 1024; // 10 MB

/// Partition entries into `num_chunks` chunks balanced by total bytes.
fn partition_by_bytes(
    entries: &[(usize, String, u64, bool)],
    num_chunks: usize,
    total_bytes: u64,
) -> Vec<Vec<(usize, String, u64, bool)>> {
    let bytes_per = (total_bytes / num_chunks as u64).max(1);
    let mut chunks: Vec<Vec<_>> = (0..num_chunks).map(|_| Vec::new()).collect();
    let mut cur = 0usize;
    let mut cur_bytes = 0u64;
    for e in entries {
        if cur_bytes >= bytes_per && cur < num_chunks - 1 {
            cur += 1;
            cur_bytes = 0;
        }
        cur_bytes += e.2;
        chunks[cur].push(e.clone());
    }
    chunks.retain(|c| !c.is_empty());
    chunks
}

/// Lightweight progress message sent from worker threads to the main thread.
struct ChunkProgress {
    current_file: String,
    file_bytes: u64,
}

/// Decompress a single entry to disk. Returns bytes written.
fn decompress_entry_to_disk<R: Read>(entry: &mut R, out_path: &Path) -> io::Result<u64> {
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let out = File::create(out_path)?;
    let mut writer = BufWriter::with_capacity(256 * 1024, out);
    let mut buf = vec![0u8; COPY_BUF_KB * 1024];
    let mut written: u64 = 0;
    loop {
        let n = entry.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        written += n as u64;
    }
    writer.flush()?;
    Ok(written)
}

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

        // Quick gate: too few files, go serial immediately
        if total_files < PARALLEL_MIN_FILES {
            return extract_serial(zip, dest, password, total_files, on_progress);
        }

        // Pre-scan entries for parallel consideration
        let mut entry_meta: Vec<(usize, String, u64, bool)> = Vec::with_capacity(total_files);
        let mut total_bytes: u64 = 0;
        for i in 0..total_files {
            let entry = zip.by_index(i).map_err(map_zip_err)?;
            let size = entry.size();
            total_bytes += size;
            entry_meta.push((i, decode_cjk_name(entry.name_raw()), size, entry.is_dir()));
        }

        // Gate: large enough + no password → parallel
        if total_bytes >= PARALLEL_MIN_BYTES && password.is_none() {
            drop(zip);
            return extract_parallel(archive, dest, &entry_meta, total_files, total_bytes, on_progress);
        }

        // Fall through to serial using pre-scanned metadata
        extract_serial_with_meta(zip, dest, password, &entry_meta, total_bytes, on_progress)
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
                decompress_entry_to_disk(&mut entry, &out)?;
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

/// Serial extraction (original path). Used when archive has few files.
fn extract_serial(
    mut zip: ZipArchive<File>,
    dest: &Path,
    password: Option<&str>,
    total_files: usize,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<(), ArchiveError> {
    let mut total_bytes: u64 = 0;
    for i in 0..total_files {
        if let Ok(entry) = zip.by_index(i) {
            total_bytes += entry.size();
        }
    }
    extract_serial_impl(zip, dest, password, total_files, total_bytes, on_progress)
}

/// Serial extraction reusing pre-scanned metadata.
fn extract_serial_with_meta(
    zip: ZipArchive<File>,
    dest: &Path,
    password: Option<&str>,
    entry_meta: &[(usize, String, u64, bool)],
    total_bytes: u64,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<(), ArchiveError> {
    extract_serial_impl(zip, dest, password, entry_meta.len(), total_bytes, on_progress)
}

/// Shared serial extraction implementation.
fn extract_serial_impl(
    mut zip: ZipArchive<File>,
    dest: &Path,
    password: Option<&str>,
    total_files: usize,
    total_bytes: u64,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<(), ArchiveError> {
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

        // Emit at file boundary
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

/// Multi-threaded extraction using std::thread::scope.
/// Each worker opens its own File + ZipArchive, processes a chunk of entries.
/// Progress is sent via mpsc channel to the main scope thread.
fn extract_parallel(
    archive: &Path,
    dest: &Path,
    entry_meta: &[(usize, String, u64, bool)],
    total_files: usize,
    total_bytes: u64,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<(), ArchiveError> {
    let num_threads = thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(entry_meta.len());
    let chunks = partition_by_bytes(entry_meta, num_threads, total_bytes);

    let (tx, rx) = mpsc::channel::<ChunkProgress>();
    let first_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    thread::scope(|s| {
        for chunk in &chunks {
            let tx = tx.clone();
            let err_ref = Arc::clone(&first_err);
            let archive_path = archive.to_path_buf();
            let dest_dir = dest.to_path_buf();
            let owned_chunk: Vec<_> = chunk.to_vec();

            s.spawn(move || {
                if err_ref.lock().unwrap().is_some() {
                    return;
                }

                let result = (|| -> Result<(), ArchiveError> {
                    let file = File::open(&archive_path)?;
                    let mut zip = ZipArchive::new(file)
                        .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;

                    for (index, name, _size, is_dir) in &owned_chunk {
                        if err_ref.lock().unwrap().is_some() {
                            return Ok(());
                        }

                        let file_bytes = if *is_dir {
                            let out_path = dest_dir.join(name);
                            fs::create_dir_all(&out_path)?;
                            0u64
                        } else {
                            let mut entry = zip.by_index(*index).map_err(map_zip_err)?;
                            let rel = decode_zip_path(entry.name_raw())
                                .ok_or_else(|| ArchiveError::InvalidArchive(
                                    "entry has an unsafe path".into()))?;
                            let out_path = dest_dir.join(rel);
                            decompress_entry_to_disk(&mut entry, &out_path)?
                        };

                        let _ = tx.send(ChunkProgress {
                            current_file: name.clone(),
                            file_bytes,
                        });
                    }
                    Ok(())
                })();

                if let Err(e) = result {
                    let mut guard = err_ref.lock().unwrap();
                    if guard.is_none() {
                        *guard = Some(e.to_string());
                    }
                }
            });
        }
        drop(tx);

        let mut bytes_done = 0u64;
        for (i, msg) in rx.into_iter().enumerate() {
            let files_done = i + 1;
            bytes_done += msg.file_bytes;
            on_progress(Progress {
                current_file: msg.current_file,
                files_done,
                files_total: total_files,
                bytes_done,
                bytes_total: total_bytes,
            });
        }
    });

    let guard = first_err.lock().unwrap();
    if let Some(ref err) = *guard {
        return Err(ArchiveError::InvalidArchive(err.clone()));
    }

    on_progress(Progress {
        current_file: String::new(),
        files_done: total_files,
        files_total: total_files,
        bytes_done: total_bytes,
        bytes_total: total_bytes,
    });

    Ok(())
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
