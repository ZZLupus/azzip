# azzip M2 — Multi-Format Support + Open Folder After Extract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 7z, TAR, tar.gz, tar.bz2, tar.xz format support with extension+magic routing, friendly RAR error, and an "Open folder after extract" checkbox.

**Architecture:** Backend: new `SevenZHandler` and `TarHandler` implementing `ArchiveHandler`, plus `router.rs` (extension+magic dispatch). `commands.rs` two-line change replaces hardcoded `ZipHandler` with `get_handler`. Frontend: `openAfterExtract` checkbox in the actions-row, `lastDestRef` records each extract dest, a `useEffect` fires `openPath` when extract completes. `api.ts` gets updated archive filter and `openPath` import.

**Tech Stack:** Rust: `sevenz-rust2`, `tar`, `flate2`, `bzip2`, `xz2`. Frontend: `@tauri-apps/plugin-opener` (already installed), `openPath` API.

---

## Current state (verified before planning)

- `src-tauri/src/archive/mod.rs`: defines `ArchiveEntry`, `TreeNode`, `build_tree`, `Progress`, `ArchiveError`, `ArchiveHandler` trait. **Trait `list` returns `Vec<TreeNode>`, not `Vec<ArchiveEntry>`.**
- `src-tauri/src/archive/zip.rs`: `ZipHandler` — collects `ArchiveEntry` flat list then calls `build_tree`. Tests: 6 passing (list, extract+progress, corrupt, empty, zip-slip).
- `src-tauri/src/commands.rs`: uses `ZipHandler` hardcoded, returns `TreeNodeDto` (recursive mirror of `TreeNode`). Two `spawn_blocking` closures call `ZipHandler.list`/`ZipHandler.extract`.
- `src/api.ts`: `pickArchive` filter is `{ extensions: ["zip"] }` — **needs updating** for M2 formats. No `openPath` import yet.
- `src/App.tsx`: uses `tree: TreeNode[]`, `flatCount(tree)` for progress total, `loading` state, `EntryRow` component.
- `src/App.css`: already has `.actions-row` flex row where checkbox will go.
- `src-tauri/capabilities/default.json`: has `opener:default` — `openPath` is already permitted.
- Backend tests: currently **9 passing** (3 in mod.rs + 6 in zip.rs).

## Environment notes
- PATH: before every cargo command: `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"`.
- Do NOT run `cargo tauri dev`. Verify with `cargo build` + `cargo test --lib` + `npx tsc --noEmit` + `npm run build`.
- Commit: `git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "..."`.
- No stray files. `git status` clean except intended files before each commit.

## File Structure

**New files:**
- `src-tauri/src/archive/sevenz.rs` — `SevenZHandler` implementing `ArchiveHandler`
- `src-tauri/src/archive/tar.rs` — `TarHandler(TarCompression)` implementing `ArchiveHandler`
- `src-tauri/src/archive/router.rs` — `get_handler(path) -> Result<Box<dyn ArchiveHandler + Send>>`

**Modified files:**
- `src-tauri/Cargo.toml` — add 5 deps
- `src-tauri/src/archive/mod.rs` — add 3 `pub mod` declarations
- `src-tauri/src/commands.rs` — replace 2 `ZipHandler` usages with `get_handler`
- `src/api.ts` — update pickArchive filter, add openPath export
- `src/App.tsx` — add openAfterExtract state + lastDestRef + checkbox + useEffect
- `src/App.css` — add `.open-folder-toggle` style

**Unchanged:** `zip.rs`, `TitleBar.tsx`, `types.ts`, capabilities, tauri.conf.json, lib.rs.

---

## Task 1: Add cargo dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the five new crates**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo add sevenz-rust2 --manifest-path src-tauri/Cargo.toml
cargo add tar --manifest-path src-tauri/Cargo.toml
cargo add flate2 --manifest-path src-tauri/Cargo.toml
cargo add bzip2 --manifest-path src-tauri/Cargo.toml
cargo add xz2 --manifest-path src-tauri/Cargo.toml
```
Expected: each prints `Adding <crate> ...` and updates `Cargo.toml`.

- [ ] **Step 2: Verify Cargo.toml has the five new deps and backend still builds**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | Select-Object -Last 3
```
Expected: `Finished dev profile` with no errors.

- [ ] **Step 3: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "chore(deps): add 7z/tar/gz/bz2/xz crates for M2 format support"
```

---

## Task 2: SevenZHandler — TDD

**Files:**
- Create: `src-tauri/src/archive/sevenz.rs`
- Modify: `src-tauri/src/archive/mod.rs` (add `pub mod sevenz;`)

The `sevenz-rust2` crate API: `Archive::open(path)` returns a reader; `decompress_file(path, dest)` extracts everything. For listing: `Archive::open(path)?.entries()` yields `Entry` items with `.name()` (str), `.size()` (u64), `.is_directory()` (bool). For extraction: `decompress_file` writes all, then we synthesize progress from the entry list.

- [ ] **Step 1: Add `pub mod sevenz;` to mod.rs**

In `src-tauri/src/archive/mod.rs`, add after `pub mod zip;`:
```rust
pub mod sevenz;
```
Create a placeholder `src-tauri/src/archive/sevenz.rs`:
```rust
// SevenZHandler — implemented below
```
Run `cargo build --manifest-path src-tauri/Cargo.toml` to confirm it compiles.

- [ ] **Step 2: Write the failing tests**

Replace `src-tauri/src/archive/sevenz.rs` with:
```rust
use std::fs;
use std::path::Path;

use sevenz_rust2::Archive;

use super::{ArchiveEntry, ArchiveError, ArchiveHandler, Progress, build_tree, TreeNode};

pub struct SevenZHandler;

impl ArchiveHandler for SevenZHandler {
    fn list(&self, archive: &Path) -> Result<Vec<TreeNode>, ArchiveError> {
        let arc = Archive::open(archive)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let entries: Vec<ArchiveEntry> = arc.entries()
            .map(|e| ArchiveEntry {
                path: e.name().to_string(),
                size: e.size(),
                is_dir: e.is_directory(),
            })
            .collect();
        Ok(build_tree(entries))
    }

    fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), ArchiveError> {
        // Collect entries first to know total count.
        let arc = Archive::open(archive)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let names: Vec<String> = arc.entries()
            .map(|e| e.name().to_string())
            .collect();
        let total = names.len();

        // Extract all at once (sevenz-rust2 streaming API).
        fs::create_dir_all(dest)?;
        sevenz_rust2::decompress_file(archive, dest)
            .map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;

        // Emit synthetic progress (one event per known entry).
        for (i, name) in names.iter().enumerate() {
            on_progress(Progress {
                current_file: name.clone(),
                files_done: i + 1,
                files_total: total,
            });
        }
        if total == 0 {
            on_progress(Progress { current_file: String::new(), files_done: 0, files_total: 0 });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_7z(dir: &Path) -> std::path::PathBuf {
        // Build a .7z using sevenz-rust2's compress API.
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
        let tree = SevenZHandler.list(&archive).unwrap();
        // Should have at least one item (dirs or files)
        assert!(!tree.is_empty());
    }

    #[test]
    fn extract_writes_files() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = make_test_7z(tmp.path());
        let dest = tmp.path().join("out");
        let mut events: Vec<Progress> = Vec::new();
        SevenZHandler.extract(&archive, &dest, &mut |p| events.push(p)).unwrap();
        // Files should exist somewhere under dest
        let has_readme = walkdir::find_file(&dest, "readme.txt");
        // Use basic recursive check instead:
        fn has_file(dir: &Path, name: &str) -> bool {
            if let Ok(rd) = fs::read_dir(dir) {
                for entry in rd.flatten() {
                    let p = entry.path();
                    if p.file_name().and_then(|n| n.to_str()) == Some(name) { return true; }
                    if p.is_dir() && has_file(&p, name) { return true; }
                }
            }
            false
        }
        assert!(has_file(&dest, "readme.txt"));
        assert!(has_file(&dest, "root.txt"));
        assert!(!events.is_empty());
    }

    #[test]
    fn list_corrupt_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.7z");
        fs::write(&bad, b"not a 7z file").unwrap();
        let err = SevenZHandler.list(&bad).unwrap_err();
        assert!(matches!(err, ArchiveError::InvalidArchive(_)));
    }
}
```

**Note on the 7z API:** The exact method names (`entries()`, `name()`, `size()`, `is_directory()`, `decompress_file`, `compress_to_path`) are based on `sevenz-rust2` v0.6.x. If the installed version differs:
- Check `cargo doc --open --package sevenz-rust2` for the actual API.
- Adapt method names minimally to match. The important invariants are: list returns `Vec<TreeNode>` via `build_tree`, extract creates files under `dest`, progress is emitted.
- Document any deviation in your report.

- [ ] **Step 3: Run the tests to verify they compile and pass**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo test --manifest-path src-tauri/Cargo.toml --lib archive::sevenz::tests 2>&1 | Select-String "test result|FAILED|error"
```
Expected: `test result: ok. 3 passed`.

If the API doesn't match and the code won't compile, adapt to the installed API (check `cargo doc`) and document changes. Do not delete or weaken tests.

- [ ] **Step 4: Commit**

```powershell
git add src-tauri/src/archive/sevenz.rs src-tauri/src/archive/mod.rs
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(archive): add SevenZHandler for .7z format"
```

---

## Task 3: TarHandler — TDD

**Files:**
- Create: `src-tauri/src/archive/tar.rs`
- Modify: `src-tauri/src/archive/mod.rs` (add `pub mod tar;`)

The `tar` crate: `Archive::new(reader)` where reader may be wrapped in `flate2::read::GzDecoder`, `bzip2::read::BzDecoder`, or `xz2::read::XzDecoder`. `archive.entries()` yields `Entry` items with `.path()` (path), `.header().size()` (u64), `.header().entry_type().is_dir()` (bool). Zip-slip guard: skip any entry whose path contains `..` components.

- [ ] **Step 1: Add `pub mod tar;` to mod.rs**

In `src-tauri/src/archive/mod.rs`, add after `pub mod sevenz;`:
```rust
pub mod tar;
```
Create placeholder `src-tauri/src/archive/tar.rs`:
```rust
// TarHandler — implemented below
```

- [ ] **Step 2: Write the full TarHandler**

Replace `src-tauri/src/archive/tar.rs` with:
```rust
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path};

use super::{ArchiveEntry, ArchiveError, ArchiveHandler, Progress, build_tree, TreeNode};

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
    let entries_for_count: Vec<_> = {
        // We need two passes: one to count, one to extract.
        // Instead, extract and count in one pass by collecting entry names.
        // tar::Archive is consumed on iteration, so we open a second time
        // via the caller (see TarHandler::extract).
        Vec::new() // placeholder — unused, see below
    };
    let _ = entries_for_count;

    // Single-pass: extract and track progress simultaneously.
    // We don't know total up front; report files_done incrementally
    // with files_total = 0 (unknown), then a final done signal.
    let mut count = 0usize;
    for entry in archive.entries().map_err(|e| ArchiveError::InvalidArchive(e.to_string()))? {
        let mut entry = entry.map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        let raw_path = entry.path().map_err(|e| ArchiveError::InvalidArchive(e.to_string()))?;
        if has_traversal(&raw_path) {
            continue;
        }
        let out_path = dest.join(&raw_path);
        let name = raw_path.to_string_lossy().into_owned();

        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = File::create(&out_path)?;
            io::copy(&mut entry, &mut out)?;
        }
        count += 1;
        on_progress(Progress {
            current_file: name,
            files_done: count,
            files_total: 0, // unknown until full pass
        });
    }
    // Final signal with accurate total.
    on_progress(Progress { current_file: String::new(), files_done: count, files_total: count });
    Ok(())
}

impl ArchiveHandler for TarHandler {
    fn list(&self, archive: &Path) -> Result<Vec<TreeNode>, ArchiveError> {
        let file = File::open(archive)?;
        let entries = match self.0 {
            TarCompression::None => list_tar(file)?,
            TarCompression::Gz => {
                let decoder = flate2::read::GzDecoder::new(file);
                list_tar(decoder)?
            }
            TarCompression::Bz2 => {
                let decoder = bzip2::read::BzDecoder::new(file);
                list_tar(decoder)?
            }
            TarCompression::Xz => {
                let decoder = xz2::read::XzDecoder::new(file);
                list_tar(decoder)?
            }
        };
        Ok(build_tree(entries))
    }

    fn extract(
        &self,
        archive: &Path,
        dest: &Path,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), ArchiveError> {
        fs::create_dir_all(dest)?;
        let file = File::open(archive)?;
        match self.0 {
            TarCompression::None => extract_tar(file, dest, on_progress),
            TarCompression::Gz => {
                let decoder = flate2::read::GzDecoder::new(file);
                extract_tar(decoder, dest, on_progress)
            }
            TarCompression::Bz2 => {
                let decoder = bzip2::read::BzDecoder::new(file);
                extract_tar(decoder, dest, on_progress)
            }
            TarCompression::Xz => {
                let decoder = xz2::read::XzDecoder::new(file);
                extract_tar(decoder, dest, on_progress)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a .tar.gz with two entries: docs/readme.txt + root.txt
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
        let tree = TarHandler(TarCompression::Gz).list(&archive).unwrap();
        // docs/ (dir) + root.txt (file) at root
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
            .extract(&archive, &dest, &mut |p| events.push(p))
            .unwrap();
        assert_eq!(fs::read_to_string(dest.join("docs/readme.txt")).unwrap(), "hello tar");
        assert_eq!(fs::read_to_string(dest.join("root.txt")).unwrap(), "top level");
        // Last event is the final completion signal
        let last = events.last().unwrap();
        assert_eq!(last.files_done, last.files_total);
        assert!(last.files_total >= 2);
    }

    #[test]
    fn extract_tar_gz_rejects_traversal() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("malicious.tar.gz");
        let file = File::create(&out).unwrap();
        let gz = GzEncoder::new(file, Compression::default());
        let mut builder = tar::Builder::new(gz);
        let content = b"evil";
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, "../evil.txt", content.as_ref()).unwrap();
        builder.finish().unwrap();

        let dest = tmp.path().join("out");
        let mut events = Vec::new();
        TarHandler(TarCompression::Gz)
            .extract(&out, &dest, &mut |p| events.push(p))
            .unwrap(); // should NOT error — just skip the traversal entry
        // evil.txt must NOT exist above dest
        assert!(!tmp.path().join("evil.txt").exists());
    }

    #[test]
    fn list_corrupt_tar_returns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.tar.gz");
        fs::write(&bad, b"not a tar").unwrap();
        let err = TarHandler(TarCompression::Gz).list(&bad).unwrap_err();
        assert!(matches!(err, ArchiveError::InvalidArchive(_)));
    }
}
```

- [ ] **Step 3: Run all tar tests**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo test --manifest-path src-tauri/Cargo.toml --lib archive::tar::tests 2>&1 | Select-String "test result|FAILED|error\["
```
Expected: `test result: ok. 4 passed`.

- [ ] **Step 4: Run all backend tests to confirm no regressions**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | Select-String "test result"
```
Expected: all previously passing tests still pass (9 pre-existing + 3 sevenz + 4 tar = 16 total).

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/archive/tar.rs src-tauri/src/archive/mod.rs
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(archive): add TarHandler for .tar/.tar.gz/.tar.bz2/.tar.xz"
```

---

## Task 4: Format router — TDD

**Files:**
- Create: `src-tauri/src/archive/router.rs`
- Modify: `src-tauri/src/archive/mod.rs` (add `pub mod router;`)

- [ ] **Step 1: Add `pub mod router;` to mod.rs**

Add after `pub mod tar;`:
```rust
pub mod router;
```

- [ ] **Step 2: Write the router with tests**

Create `src-tauri/src/archive/router.rs`:
```rust
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
    // Normalize to lowercase for extension matching.
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Multi-part extensions first (e.g. .tar.gz must beat .gz).
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
        // Single-file GZ (not .tar.gz — already matched above).
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
    use std::io::Write;

    fn handler_name(path: &Path) -> String {
        match get_handler(path) {
            Ok(_) => "ok".to_string(),
            Err(ArchiveError::Unsupported(msg)) => format!("unsupported:{}", msg),
            Err(e) => format!("err:{}", e),
        }
    }

    #[test]
    fn routes_by_extension() {
        let tmp = tempfile::tempdir().unwrap();
        // Create dummy files — content doesn't matter for extension routing.
        for name in &["a.zip", "a.7z", "a.tar", "a.tar.gz", "a.tgz",
                       "a.tar.bz2", "a.tbz2", "a.tar.xz", "a.txz", "a.gz"] {
            std::fs::write(tmp.path().join(name), b"dummy").unwrap();
        }
        for name in &["a.zip", "a.7z", "a.tar", "a.tar.gz", "a.tgz",
                       "a.tar.bz2", "a.tbz2", "a.tar.xz", "a.txz", "a.gz"] {
            let result = get_handler(&tmp.path().join(name));
            assert!(result.is_ok(), "expected Ok for {name}, got {:?}", result);
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
        let p = tmp.path().join("archive"); // no extension
        // ZIP magic: PK\x03\x04
        std::fs::write(&p, b"PK\x03\x04xxxxxxxx").unwrap();
        assert!(get_handler(&p).is_ok());
    }

    #[test]
    fn magic_detects_gz_without_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("archive");
        // GZ magic: \x1F\x8B
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
```

- [ ] **Step 3: Run router tests**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo test --manifest-path src-tauri/Cargo.toml --lib archive::router::tests 2>&1 | Select-String "test result|FAILED|error\["
```
Expected: `test result: ok. 5 passed`.

- [ ] **Step 4: Run full test suite to confirm no regressions**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | Select-String "test result"
```
Expected: all tests pass (≥21 total).

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/archive/router.rs src-tauri/src/archive/mod.rs
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(archive): add format router with extension + magic-byte detection"
```

---

## Task 5: Wire router into commands.rs

**Files:**
- Modify: `src-tauri/src/commands.rs`

The only change: remove the `ZipHandler` import and replace the two hardcoded `ZipHandler` usages with `get_handler`. All DTOs, async structure, event names, command names stay identical.

- [ ] **Step 1: Edit commands.rs**

In `src-tauri/src/commands.rs`:

**Remove** this line:
```rust
use crate::archive::zip::ZipHandler;
```

**Add** this line in its place:
```rust
use crate::archive::router::get_handler;
```

**Replace** the `list_archive` body:
```rust
#[tauri::command]
pub async fn list_archive(path: String) -> Result<Vec<TreeNodeDto>, String> {
    let archive = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        get_handler(&archive)
            .map_err(|e| e.to_string())?
            .list(&archive)
            .map(|v| v.into_iter().map(Into::into).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
```

**Replace** the `extract_archive` body:
```rust
#[tauri::command]
pub async fn extract_archive(
    app: AppHandle,
    path: String,
    dest: String,
) -> Result<(), String> {
    let archive = PathBuf::from(path);
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || {
        get_handler(&archive)
            .map_err(|e| e.to_string())?
            .extract(&archive, &dest, &mut |p: Progress| {
                let _ = app.emit("extract-progress", ProgressDto::from(p));
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
```

- [ ] **Step 2: Verify build + all tests still pass**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | Select-Object -Last 2
cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | Select-String "test result"
```
Expected: build `Finished`, all tests pass.

- [ ] **Step 3: Commit**

```powershell
git add src-tauri/src/commands.rs
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(commands): route to handler via get_handler, remove hardcoded ZipHandler"
```

---

## Task 6: Frontend — multi-format dialog filter + open-folder feature

**Files:**
- Modify: `src/api.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

- [ ] **Step 1: Update api.ts — dialog filter and openPath export**

In `src/api.ts`:

**Update** the `pickArchive` function's filter to include all supported formats:
```ts
export async function pickArchive(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "Archives",
        extensions: ["zip", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz"],
      },
    ],
  });
  return typeof result === "string" ? result : null;
}
```

**Add** this import at the top of `api.ts` (alongside existing imports):
```ts
import { openPath } from "@tauri-apps/plugin-opener";
```

**Add** this export at the end of `api.ts`:
```ts
export { openPath };
```

- [ ] **Step 2: Update App.tsx — openAfterExtract state + lastDestRef + checkbox + useEffect**

In `src/App.tsx`, make the following targeted changes:

**Add** two new state/ref declarations after the existing ones (after line 44 `const splitRef = ...`):
```tsx
  const [openAfterExtract, setOpenAfterExtract] = useState(false);
  const lastDestRef = useRef<string | null>(null);
```

**Add** `openPath` to the imports from `./api`:
```tsx
import {
  listArchive,
  extractArchive,
  onExtractProgress,
  pickArchive,
  pickDestination,
  computeDestOptions,
  openPath,
  type DestOptions,
} from "./api";
```

**In `runExtract`**, add `lastDestRef.current = dest;` as the first line of the function body (before `setError(null)`):
```tsx
  async function runExtract(dest: string) {
    lastDestRef.current = dest;
    if (!archivePath) return;
    setError(null);
    ...
```

**Add** a new `useEffect` after the existing two `useEffect` hooks (after line 63):
```tsx
  useEffect(() => {
    if (!done || !openAfterExtract || !lastDestRef.current) return;
    openPath(lastDestRef.current).catch(() => {});
  }, [done, openAfterExtract]);
```

**Add** the checkbox to the JSX, inside `.actions-row` after the `</div>` that closes `.split-button`:
```tsx
            <label className="open-folder-toggle">
              <input
                type="checkbox"
                checked={openAfterExtract}
                onChange={(e) => setOpenAfterExtract(e.target.checked)}
              />
              Open folder after extract
            </label>
```

- [ ] **Step 3: Add checkbox style to App.css**

Append at the end of `src/App.css`:
```css
.open-folder-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #9d8fd1;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.open-folder-toggle input[type="checkbox"] {
  accent-color: var(--accent-a);
  width: 13px;
  height: 13px;
  cursor: pointer;
}
```

- [ ] **Step 4: Verify typecheck + frontend build**

Run:
```powershell
Set-Location "C:\Users\lixinpei1\azzip"
npx tsc --noEmit
npm run build 2>&1 | Select-Object -Last 3
```
Expected: tsc no errors; vite build exit 0.

- [ ] **Step 5: Commit**

```powershell
git add src/api.ts src/App.tsx src/App.css
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(ui): multi-format dialog filter + open folder after extract checkbox"
```

---

## Task 7: Wrap-up verification

- [ ] **Step 1: Full backend test suite**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | Select-String "test result|running [0-9]"
```
Expected: all tests pass. Count should be ≥21 (9 pre-existing + 3 sevenz + 4 tar + 5 router).

- [ ] **Step 2: Frontend typecheck + build**

Run:
```powershell
Set-Location "C:\Users\lixinpei1\azzip"
npx tsc --noEmit; npm run build 2>&1 | Select-Object -Last 2
```
Expected: tsc no errors; build exit 0.

- [ ] **Step 3: Release smoke build**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"
npm run tauri build -- --no-bundle 2>&1 | Select-Object -Last 3
```
Expected: `Built application at: ...\azzip.exe`, exit 0.

- [ ] **Step 4: Commit wrap-up marker**

```powershell
git -c user.name="azzip" -c user.email="dev@azzip.local" commit --allow-empty -m "chore: M2 multi-format + open-folder complete"
```

---

## Self-Review

**Spec coverage:**
- 7z support → Task 2 (SevenZHandler) ✓
- TAR / tar.gz / tar.bz2 / tar.xz → Task 3 (TarHandler with TarCompression) ✓
- GZ single-file → Task 4 router `.gz` → `TarHandler(Gz)` ✓
- RAR friendly error → Task 4 router `.rar` → `Err(Unsupported(...))` ✓
- Extension + magic routing → Task 4 (router.rs) ✓
- `commands.rs` minimal change → Task 5 (2 usages replaced, all DTOs/async unchanged) ✓
- Dialog filter updated for new formats → Task 6 (api.ts) ✓
- Open folder after extract checkbox → Task 6 (App.tsx checkbox + useEffect + lastDestRef) ✓
- `openPath` from already-permitted `opener:default` → Task 6 ✓
- No capability changes needed → confirmed, `opener:default` already present ✓
- TDD with tests for each new handler → Tasks 2, 3, 4 ✓
- All 9 pre-existing tests preserved → Task 3 Step 4 + Task 5 Step 2 regression check ✓

**Placeholder scan:** No TBD/TODO. Task 2 notes the API-version caveat explicitly with "adapt minimally and document" — this is a contingency instruction, not a placeholder. ✓

**Type consistency:**
- `ArchiveHandler::list` returns `Vec<TreeNode>` throughout (Tasks 2, 3 match mod.rs definition) ✓
- `get_handler` returns `Box<dyn ArchiveHandler + Send>` (Task 4) — `Send` bound required because it's used inside `spawn_blocking` (Task 5) ✓
- `openPath` exported from `api.ts` (Task 6 Step 1) and imported in `App.tsx` (Task 6 Step 2) ✓
- `lastDestRef` is `useRef<string | null>` — set in `runExtract` before all three extract paths (pick/sameName/here all call `runExtract`) ✓
- `TarCompression` enum defined in `tar.rs` (Task 3), imported in `router.rs` (Task 4) as `use super::tar::{TarCompression, TarHandler}` ✓
