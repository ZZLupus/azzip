# azzip Milestone 1: Foundation + ZIP Extraction Vertical Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a working Tauri app that opens a ZIP archive, lists its contents in the UI, and extracts it to a chosen folder with live progress — validating the full stack and locking in the core architecture.

**Architecture:** Tauri 2.x app. Rust backend exposes an `ArchiveHandler` trait (one implementation this milestone: ZIP). Tauri commands wrap the engine and emit progress events during long extractions. React + TypeScript + Vite frontend calls commands via `invoke` and subscribes to events. The engine layer is pure Rust, unit-tested without Tauri.

**Tech Stack:** Rust (stable, MSVC toolchain), Tauri 2.x, `zip` crate, `thiserror`, `tempfile` (dev), Node 25 / npm, React 18 + TypeScript + Vite, `@tauri-apps/api`, `@tauri-apps/plugin-dialog`.

---

## Milestone Roadmap (context — only Milestone 1 is detailed below)

- **M1 (this plan):** Scaffold + `ArchiveHandler` trait + ZIP list/extract + minimal UI with progress. **Produces working software.**
- **M2:** Add engines — 7z, TAR, GZ/tar.gz, RAR (extract). Format routing by extension/magic bytes.
- **M3:** Create archives (ZIP/7z) + drag-to-compress UI.
- **M4:** Password support (encrypted extract + create) + in-archive preview + selective single-file extract.
- **M5:** Windows shell integration (`azzip →` submenu via `IExplorerCommand`, file association first-run prompt, double-click behavior) + MSIX/sparse packaging + dark/light theme polish.

Each later milestone gets its own plan when we reach it.

---

## File Structure (Milestone 1)

**Rust backend (`src-tauri/`):**
- `src-tauri/Cargo.toml` — deps
- `src-tauri/src/main.rs` — entry, delegates to lib
- `src-tauri/src/lib.rs` — builder, registers commands
- `src-tauri/src/archive/mod.rs` — module exports + shared types (`ArchiveEntry`, `ArchiveError`, `Progress`, `ArchiveHandler` trait)
- `src-tauri/src/archive/zip.rs` — `ZipHandler` implementing the trait
- `src-tauri/src/commands.rs` — `list_archive`, `extract_archive` Tauri commands

**Frontend (`src/`):**
- `src/App.tsx` — main view: open, list, extract, progress
- `src/api.ts` — typed wrappers over `invoke` + event listeners
- `src/types.ts` — shared TS types mirroring Rust DTOs

**Config:**
- `src-tauri/tauri.conf.json` — app config, dialog plugin

---

## Task 0: Environment Setup (one-time, prerequisite)

**Files:** none (tooling install). This task has no automated test — verification is the version checks.

- [ ] **Step 1: Install Rust (MSVC toolchain) via rustup**

In PowerShell, download and run rustup:
```powershell
Invoke-WebRequest https://win.rustup.rs/x86_64 -OutFile "$env:TEMP\rustup-init.exe"
& "$env:TEMP\rustup-init.exe" -y --default-toolchain stable --default-host x86_64-pc-windows-msvc
```
Then restart the shell so PATH updates.

- [ ] **Step 2: Ensure MSVC C++ build tools + WebView2**

Tauri needs the MSVC linker and WebView2 runtime.
- Install "Desktop development with C++" from Visual Studio Build Tools if `cl.exe` is missing:
  ```powershell
  winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```
- WebView2 ships with Windows 11 (already present). If missing: `winget install Microsoft.EdgeWebView2Runtime`.

- [ ] **Step 3: Install Tauri CLI**

```powershell
cargo install tauri-cli --version "^2.0"
```

- [ ] **Step 4: Verify toolchain**

Run:
```powershell
rustc --version; cargo --version; cargo tauri --version; node -v; npm -v
```
Expected: rustc/cargo print versions (stable), `cargo tauri` prints a 2.x version, node prints v25.x, npm prints 11.x. All must succeed before continuing.

---

## Task 1: Scaffold Tauri + React + TS project

**Files:**
- Create: whole `src-tauri/` and `src/` tree via scaffolder
- Modify: `.gitignore` (already has `node_modules/`, `target/`, `dist/`)

- [ ] **Step 1: Scaffold into the existing repo**

The repo root `C:/Users/lixinpei1/azzip` already has `.git`, `docs/`, `.gitignore`. Scaffold into a temp dir then move, to avoid the tool refusing a non-empty dir. From the repo root:
```powershell
npm create tauri-app@latest azzip-scaffold -- --template react-ts --manager npm
Copy-Item -Recurse -Force azzip-scaffold\* .
Copy-Item -Force azzip-scaffold\.gitignore .gitignore-scaffold 2>$null
Remove-Item -Recurse -Force azzip-scaffold
```
Merge any scaffold `.gitignore-scaffold` entries into the existing `.gitignore` manually if present, then delete it.

- [ ] **Step 2: Install frontend deps + dialog plugin**

```powershell
npm install
npm install @tauri-apps/plugin-dialog
```
Add the Rust side of the dialog plugin:
```powershell
cargo add tauri-plugin-dialog --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 3: Verify the app builds and runs (dev)**

Run:
```powershell
cargo tauri dev
```
Expected: a window opens showing the default Tauri+React template. Close it.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "chore: scaffold Tauri 2 + React + TS app"
```

---

## Task 2: Define the archive module — shared types + `ArchiveHandler` trait

**Files:**
- Create: `src-tauri/src/archive/mod.rs`
- Modify: `src-tauri/Cargo.toml` (add `zip`, `thiserror`; dev `tempfile`)
- Modify: `src-tauri/src/lib.rs` (declare `mod archive;`)

- [ ] **Step 1: Add dependencies**

```powershell
cargo add zip thiserror --manifest-path src-tauri/Cargo.toml
cargo add tempfile --dev --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 2: Write the failing test (trait + types compile and a stub handler is usable)**

Create `src-tauri/src/archive/mod.rs`:
```rust
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
```
In `src-tauri/src/lib.rs`, add near the top (below existing attributes):
```rust
mod archive;
mod commands;
```
(Leave `commands` for Task 4 — create an empty `src-tauri/src/commands.rs` now with `// commands added in Task 4` so the module resolves.)

- [ ] **Step 3: Run the test to verify it fails (then passes once it compiles)**

The `zip` submodule doesn't exist yet, so compilation fails. Create a placeholder `src-tauri/src/archive/zip.rs`:
```rust
// ZipHandler implemented in Task 3.
```
Run:
```powershell
cargo test --manifest-path src-tauri/Cargo.toml archive::tests::archive_entry_constructs
```
Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "feat(archive): add ArchiveHandler trait and shared types"
```

---

## Task 3: Implement `ZipHandler` (list + extract) — TDD

**Files:**
- Modify: `src-tauri/src/archive/zip.rs`
- Test: same file (`#[cfg(test)]` module)

- [ ] **Step 1: Write the failing test — list returns entries**

Replace `src-tauri/src/archive/zip.rs` with:
```rust
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
}
```

- [ ] **Step 2: Run the list test — verify it passes**

Run:
```powershell
cargo test --manifest-path src-tauri/Cargo.toml archive::zip::tests::list_returns_entries
```
Expected: PASS.

- [ ] **Step 3: Write the failing test — extract writes files + reports final progress**

Add to the `tests` module in `src-tauri/src/archive/zip.rs`:
```rust
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
```

- [ ] **Step 4: Run all zip tests — verify they pass**

Run:
```powershell
cargo test --manifest-path src-tauri/Cargo.toml archive::zip::tests
```
Expected: 3 tests PASS (`list_returns_entries`, `extract_writes_files_and_reports_progress`, `list_corrupt_returns_invalid_archive`).

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat(archive): implement ZipHandler list + extract with TDD"
```

---

## Task 4: Tauri commands — `list_archive` + `extract_archive` (with progress events)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register commands + dialog plugin)

- [ ] **Step 1: Write the commands**

Replace `src-tauri/src/commands.rs` with:
```rust
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::archive::zip::ZipHandler;
use crate::archive::{ArchiveEntry, ArchiveHandler, Progress};

/// DTO sent to the frontend (mirrors ArchiveEntry).
#[derive(Serialize)]
pub struct ArchiveEntryDto {
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

impl From<ArchiveEntry> for ArchiveEntryDto {
    fn from(e: ArchiveEntry) -> Self {
        ArchiveEntryDto { path: e.path, size: e.size, is_dir: e.is_dir }
    }
}

/// Progress payload emitted on the "extract-progress" event.
#[derive(Serialize, Clone)]
pub struct ProgressDto {
    pub current_file: String,
    pub files_done: usize,
    pub files_total: usize,
}

impl From<Progress> for ProgressDto {
    fn from(p: Progress) -> Self {
        ProgressDto {
            current_file: p.current_file,
            files_done: p.files_done,
            files_total: p.files_total,
        }
    }
}

#[tauri::command]
pub async fn list_archive(path: String) -> Result<Vec<ArchiveEntryDto>, String> {
    let archive = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        ZipHandler
            .list(&archive)
            .map(|v| v.into_iter().map(Into::into).collect())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn extract_archive(
    app: AppHandle,
    path: String,
    dest: String,
) -> Result<(), String> {
    let archive = PathBuf::from(path);
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || {
        ZipHandler
            .extract(&archive, &dest, &mut |p: Progress| {
                // Best-effort progress emit; ignore send errors.
                let _ = app.emit("extract-progress", ProgressDto::from(p));
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
```

- [ ] **Step 2: Register commands + dialog plugin in lib.rs**

In `src-tauri/src/lib.rs`, ensure the builder registers the plugin and handlers. The body of the `run()` function should look like:
```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_archive,
            commands::extract_archive
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
(Keep `mod archive;` and `mod commands;` declarations from Task 2.)

- [ ] **Step 3: Verify backend compiles**

Run:
```powershell
cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: builds with no errors.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "feat(commands): add list_archive and extract_archive with progress events"
```

---

## Task 5: Frontend — typed API layer

**Files:**
- Create: `src/types.ts`
- Create: `src/api.ts`

- [ ] **Step 1: Define shared TS types (mirror Rust DTOs)**

Create `src/types.ts`:
```ts
export interface ArchiveEntry {
  path: string;
  size: number;
  is_dir: boolean;
}

export interface Progress {
  current_file: string;
  files_done: number;
  files_total: number;
}
```

- [ ] **Step 2: Write the typed API wrappers**

Create `src/api.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { ArchiveEntry, Progress } from "./types";

export function listArchive(path: string): Promise<ArchiveEntry[]> {
  return invoke<ArchiveEntry[]>("list_archive", { path });
}

export function extractArchive(path: string, dest: string): Promise<void> {
  return invoke<void>("extract_archive", { path, dest });
}

export function onExtractProgress(
  cb: (p: Progress) => void
): Promise<UnlistenFn> {
  return listen<Progress>("extract-progress", (e) => cb(e.payload));
}

/** Open a single archive file via the native dialog. Returns null if cancelled. */
export async function pickArchive(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Archives", extensions: ["zip"] }],
  });
  return typeof result === "string" ? result : null;
}

/** Pick a destination directory. Returns null if cancelled. */
export async function pickDestination(): Promise<string | null> {
  const result = await open({ multiple: false, directory: true });
  return typeof result === "string" ? result : null;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run:
```powershell
npx tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "feat(ui): add typed API layer over Tauri commands"
```

---

## Task 6: Frontend — main view (open → list → extract → progress)

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Implement the main view**

Replace `src/App.tsx` with:
```tsx
import { useEffect, useState } from "react";
import {
  listArchive,
  extractArchive,
  onExtractProgress,
  pickArchive,
  pickDestination,
} from "./api";
import type { ArchiveEntry, Progress } from "./types";
import "./App.css";

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function App() {
  const [archivePath, setArchivePath] = useState<string | null>(null);
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    const unlistenPromise = onExtractProgress(setProgress);
    return () => {
      unlistenPromise.then((un) => un());
    };
  }, []);

  async function handleOpen() {
    setError(null);
    const path = await pickArchive();
    if (!path) return;
    try {
      const list = await listArchive(path);
      setArchivePath(path);
      setEntries(list);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleExtract() {
    if (!archivePath) return;
    setError(null);
    const dest = await pickDestination();
    if (!dest) return;
    try {
      setProgress({ current_file: "", files_done: 0, files_total: entries.length });
      await extractArchive(archivePath, dest);
    } catch (e) {
      setError(String(e));
      setProgress(null);
    }
  }

  const pct =
    progress && progress.files_total > 0
      ? Math.round((progress.files_done / progress.files_total) * 100)
      : 0;
  const done = progress !== null && progress.files_done === progress.files_total;

  return (
    <main className="container">
      <header className="toolbar">
        <h1>📦 azzip</h1>
        <div className="actions">
          <button onClick={handleOpen}>Open archive…</button>
          <button onClick={handleExtract} disabled={!archivePath}>
            ⬇ Extract all
          </button>
        </div>
      </header>

      {archivePath && <p className="path">{archivePath}</p>}
      {error && <p className="error">⚠ {error}</p>}

      {progress && (
        <div className="progress">
          <div className="bar">
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
          <span>
            {done ? "Done" : `${pct}% — ${progress.current_file}`}
          </span>
        </div>
      )}

      <table className="entries">
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.path}>
              <td>{e.is_dir ? "📁" : "📄"} {e.path}</td>
              <td className="size">{e.is_dir ? "—" : formatSize(e.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

export default App;
```

- [ ] **Step 2: Add minimal styling consistent with the confirmed dark/glass direction**

Replace `src/App.css` with:
```css
:root {
  color-scheme: dark;
  --accent-a: #a78bfa;
  --accent-b: #f0abfc;
}
body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  color: #e0e7ff;
  background: radial-gradient(1200px 600px at 0% 0%, #241b4d, #0e0c1f 60%);
  min-height: 100vh;
}
.container { padding: 18px; }
.toolbar { display: flex; align-items: center; gap: 16px; }
.toolbar h1 { font-size: 18px; margin: 0; }
.actions { margin-left: auto; display: flex; gap: 8px; }
button {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #e0e7ff;
  padding: 8px 14px;
  border-radius: 9px;
  cursor: pointer;
  backdrop-filter: blur(12px);
}
button:disabled { opacity: 0.4; cursor: default; }
.path { color: #9d8fd1; font-size: 12px; word-break: break-all; }
.error { color: #fca5a5; }
.progress { margin: 12px 0; }
.bar {
  height: 8px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 99px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-a), var(--accent-b));
  box-shadow: 0 0 12px rgba(240, 171, 252, 0.6);
  transition: width 0.2s;
}
.progress span { font-size: 11px; color: #9d8fd1; }
.entries {
  width: 100%;
  margin-top: 14px;
  border-collapse: collapse;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  overflow: hidden;
  backdrop-filter: blur(16px);
}
.entries th, .entries td {
  text-align: left;
  padding: 9px 16px;
  font-size: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.entries th {
  color: #6d6499;
  text-transform: uppercase;
  font-size: 9px;
  letter-spacing: 0.6px;
}
.entries .size { text-align: right; color: #9d8fd1; }
```

- [ ] **Step 3: Manual end-to-end verification**

Run:
```powershell
cargo tauri dev
```
Then in the app:
1. Click **Open archive…**, pick any `.zip` file → entries list populates.
2. Click **Extract all**, pick a destination folder → progress bar fills, reaches "Done", files appear in the chosen folder.
3. Try opening a non-zip file renamed to `.zip` → an error message appears (no crash).

Expected: all three behave as described.

- [ ] **Step 4: Commit**

```powershell
git add -A
git commit -m "feat(ui): main view — open, list, extract with live progress"
```

---

## Task 7: Milestone wrap-up — full test + build check

**Files:** none (verification + commit)

- [ ] **Step 1: Run the full backend test suite**

Run:
```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all tests PASS (the trait test + 3 zip tests).

- [ ] **Step 2: Typecheck frontend**

Run:
```powershell
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Production build smoke test**

Run:
```powershell
cargo tauri build
```
Expected: build succeeds and produces an installer/exe under `src-tauri/target/release/`. (This confirms the packaging path works early.)

- [ ] **Step 4: Tag the milestone**

```powershell
git add -A
git commit -m "chore: Milestone 1 complete — working ZIP extraction vertical slice" --allow-empty
git tag m1-foundation
```

---

## Self-Review

**Spec coverage (Milestone 1 scope only):**
- Tauri + Rust + pure-Rust engine architecture → Tasks 1–4 ✓
- `ArchiveHandler` trait abstraction (design decision #1) → Task 2 ✓
- Async + events for long tasks (design decision #3) → Task 4 (`spawn_blocking` + `emit`) ✓
- ZIP read/list/extract → Tasks 2–3 ✓
- Confirmed visual direction (dark/glass/gradient) → Task 6 CSS ✓
- Error handling "human words, not codes" → `ArchiveError` `#[error]` messages + UI error line ✓
- TDD with frequent commits → every task ✓
- Spec items deliberately **out of M1 scope** (other formats, create, preview, password, Windows shell integration, packaging polish, theme toggle) → roadmapped to M2–M5, not gaps. The `platform/` module (design decision #2) lands in M5 ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" left. The only `//` placeholders (empty `zip.rs`/`commands.rs`) are explicitly created then replaced within the same/next task. ✓

**Type consistency:** `ArchiveEntry {path,size,is_dir}` consistent across Rust (Task 2), DTO (Task 4), and TS (Task 5). `Progress {current_file,files_done,files_total}` consistent across Rust, `ProgressDto`, and TS. Event name `"extract-progress"` matches between `commands.rs` emit and `api.ts` listen. Command names `list_archive`/`extract_archive` match between `generate_handler!`, `invoke` calls, and Rust fn names. ✓
