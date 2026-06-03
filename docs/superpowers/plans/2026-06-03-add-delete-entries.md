# Add & Delete Entries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Add files" and "Delete" buttons to the archive detail page, allowing users to modify ZIP archives in-place.

**Architecture:** Two new Rust commands rewrite the ZIP to a temp file then rename over the original. Conflict detection is done in the frontend against the existing tree. Three new React modals handle the UI. Progress reuses the `compress-progress` event with a mode ref to distinguish the operation type.

**Tech Stack:** Rust `zip` crate 8.6.0, Tauri 2, React/TypeScript

**Spec:** `docs/superpowers/specs/2026-06-03-add-delete-entries-design.md`

---

### Task 1: Backend — ZIP rewrite helper + `add_files_to_archive` command

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Add imports at top of commands.rs**

Add `use std::collections::HashSet;` after the existing `use std::fs::{self, File};` line.

- [ ] **Step 2: Add `copy_zip_entries` helper after `compress_zip_native` (after line 379)**

```rust
/// Copy entries from an existing ZIP to a new one, skipping `skip_paths`
/// and appending `new_files`. Emits progress via `compress-progress`.
fn copy_zip_entries(
    old_path: &Path,
    new_path: &Path,
    app: &AppHandle,
    skip_paths: &HashSet<String>,
    new_files: &[(String, PathBuf)],
    total_bytes: u64,
) -> Result<(), String> {
    let old_file = File::open(old_path).map_err(|e| e.to_string())?;
    let mut old_zip = ZipArchive::new(old_file).map_err(|e| e.to_string())?;
    let new_file = File::create(new_path).map_err(|e| e.to_string())?;
    let mut new_zip = ZipWriter::new(new_file);

    let mut bytes_done: u64 = 0;
    let total_entries = old_zip.len() + new_files.len();
    let mut files_done: usize = 0;
    let mut last_emit = std::time::Instant::now();

    let mut emit = |name: &str, done: usize, total: usize, bytes: u64| {
        let now = std::time::Instant::now();
        if now.duration_since(last_emit) > std::time::Duration::from_millis(100) || done >= total {
            let _ = app.emit("compress-progress", CompressProgressDto {
                current_file: name.to_string(), files_done: done, files_total: total,
                bytes_done: bytes, bytes_total: total_bytes,
            });
            last_emit = now;
        }
    };

    // Copy existing entries (skip deleted ones)
    for i in 0..old_zip.len() {
        let mut entry = old_zip.by_index(i).map_err(|e| format!("read entry {i}: {e}"))?;
        let name = entry.name().to_string();
        if skip_paths.contains(&name) { continue; }
        if entry.is_dir() {
            new_zip.add_directory(&name, SimpleFileOptions::default()).map_err(|e| e.to_string())?;
        } else {
            new_zip.start_file(&name, SimpleFileOptions::default()).map_err(|e| e.to_string())?;
            bytes_done += io::copy(&mut entry, &mut new_zip).map_err(|e| e.to_string())?;
        }
        files_done += 1;
        emit(&name, files_done, total_entries, bytes_done);
    }

    // Add new files
    for (archive_name, disk_path) in new_files {
        if disk_path.is_dir() {
            new_zip.add_directory(archive_name, SimpleFileOptions::default()).map_err(|e| e.to_string())?;
            add_dir_to_zip(&mut new_zip, disk_path, archive_name, app, &mut bytes_done, total_bytes,
                &mut files_done, total_entries)?;
        } else {
            new_zip.start_file(archive_name, SimpleFileOptions::default()).map_err(|e| e.to_string())?;
            let mut f = File::open(disk_path).map_err(|e| e.to_string())?;
            bytes_done += io::copy(&mut f, &mut new_zip).map_err(|e| e.to_string())?;
        }
        files_done += 1;
        emit(archive_name, files_done, total_entries, bytes_done);
    }

    new_zip.finish().map_err(|e| e.to_string())?;
    emit("", total_entries, total_entries, total_bytes);
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut ZipWriter<File>, dir: &Path, prefix: &str, app: &AppHandle,
    bytes_done: &mut u64, bytes_total: u64, files_done: &mut usize, files_total: usize,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = format!("{}/{}", prefix, path.file_name().unwrap().to_string_lossy());
        if path.is_dir() {
            zip.add_directory(&name, SimpleFileOptions::default()).map_err(|e| e.to_string())?;
            add_dir_to_zip(zip, &path, &name, app, bytes_done, bytes_total, files_done, files_total)?;
        } else {
            zip.start_file(&name, SimpleFileOptions::default()).map_err(|e| e.to_string())?;
            let mut f = File::open(&path).map_err(|e| e.to_string())?;
            *bytes_done += io::copy(&mut f, zip).map_err(|e| e.to_string())?;
        }
        *files_done += 1;
        let _ = app.emit("compress-progress", CompressProgressDto {
            current_file: name, files_done: *files_done, files_total,
            bytes_done: *bytes_done, bytes_total,
        });
    }
    Ok(())
}
```

- [ ] **Step 3: Add `add_files_to_archive` command after `add_dir_to_zip`**

```rust
#[tauri::command]
pub async fn add_files_to_archive(
    app: AppHandle, archive_path: String, sources: Vec<String>,
    conflict_resolution: HashMap<String, String>,
) -> Result<(), String> {
    let archive = PathBuf::from(&archive_path);
    let ext = archive.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext != "zip" {
        return Err("Only ZIP archives are supported for adding files".to_string());
    }

    let src_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let (_fc, total_bytes) = count_compress_total(&src_paths);

    let new_files: Vec<(String, PathBuf)> = src_paths.iter().filter_map(|src| {
        let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        match conflict_resolution.get(&src.to_string_lossy().to_string()).map(|s| s.as_str()) {
            Some("skip") => None,
            Some(r) if r.starts_with("rename:") => {
                Some((r.trim_start_matches("rename:").to_string(), src.clone()))
            }
            _ => Some((name, src.clone())),
        }
    }).collect();

    if new_files.is_empty() {
        return Err("No files to add (all skipped)".to_string());
    }

    let tmp = archive.with_extension(".tmp.zip");
    let app2 = app.clone();
    let archive2 = archive.clone();

    tauri::async_runtime::spawn_blocking(move || {
        copy_zip_entries(&archive2, &tmp, &app2, &HashSet::new(), &new_files, total_bytes)?;
        fs::rename(&tmp, &archive2).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }).await.map_err(|e| e.to_string())??;

    Ok(())
}
```

- [ ] **Step 4: Verify compilation**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: Clean compile. Fix any errors.

---

### Task 2: Backend — `delete_entries` command

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Add `delete_entries` command after `add_files_to_archive`**

```rust
#[tauri::command]
pub async fn delete_entries(
    app: AppHandle, archive_path: String, entries: Vec<String>,
) -> Result<(), String> {
    let archive = PathBuf::from(&archive_path);
    let ext = archive.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext != "zip" {
        return Err("Only ZIP archives are supported for deleting entries".to_string());
    }

    // Build delete set: expand directories to all child paths
    let old_file = File::open(&archive).map_err(|e| e.to_string())?;
    let mut old_zip = ZipArchive::new(old_file).map_err(|e| e.to_string())?;
    let total_entries = old_zip.len();

    let delete_set: HashSet<String> = {
        let mut set = HashSet::new();
        for i in 0..old_zip.len() {
            let entry = old_zip.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            for del in &entries {
                let d = del.trim_end_matches('/');
                if name == d || name.starts_with(&format!("{}/", d)) {
                    set.insert(name.clone());
                    break;
                }
            }
        }
        set
    };

    if delete_set.is_empty() {
        return Err("No matching entries found to delete".to_string());
    }

    let remaining = total_entries - delete_set.len();
    let tmp = archive.with_extension(".tmp.zip");
    let app2 = app.clone();
    let archive2 = archive.clone();

    tauri::async_runtime::spawn_blocking(move || {
        copy_zip_entries(&archive2, &tmp, &app2, &delete_set, &[], (remaining * 1024) as u64)?;
        fs::rename(&tmp, &archive2).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }).await.map_err(|e| e.to_string())??;

    Ok(())
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd src-tauri && cargo check 2>&1
```

Expected: Clean compile.

- [ ] **Step 3: Run existing tests**

```bash
cd src-tauri && cargo test 2>&1
```

Expected: All existing tests pass.

---

### Task 3: Register new commands

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add commands to invoke_handler**

Find the existing `generate_handler!` call and add the two new commands:

```rust
.invoke_handler(tauri::generate_handler![
    crate::commands::list_archive,
    crate::commands::extract_archive,
    crate::commands::extract_entry,
    crate::commands::extract_to_temp,
    crate::commands::open_folder,
    crate::commands::compress_files,
    crate::commands::add_files_to_archive,
    crate::commands::delete_entries,
])
```

- [ ] **Step 2: Verify it compiles**

```bash
cd src-tauri && cargo check 2>&1
```

---

### Task 4: API layer

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1: Add `addFilesToArchive` and `deleteEntries` after `compressFiles` (around line 77)**

```typescript
export function addFilesToArchive(
  archivePath: string, sources: string[], conflictResolution: Record<string, string>,
): Promise<void> {
  return invoke<void>("add_files_to_archive", { archivePath, sources, conflictResolution });
}

export function deleteEntries(
  archivePath: string, entries: string[],
): Promise<void> {
  return invoke<void>("delete_entries", { archivePath, entries });
}
```

- [ ] **Step 2: Verify**

```bash
cd src && npx tsc --noEmit 2>&1
```

---

### Task 5: Frontend — buttons in actions row

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add state variables for new modals**

Insert after the compress state (around line 108):

```typescript
// Add/Delete state
const [addModalOpen, setAddModalOpen] = useState(false);
const [addSources, setAddSources] = useState<string[]>([]);
const [addProgressOpen, setAddProgressOpen] = useState(false);
const [addProgress, setAddProgress] = useState<import("./types").Progress | null>(null);
const [addError, setAddError] = useState<string | null>(null);
const [conflictModalOpen, setConflictModalOpen] = useState(false);
const [conflictList, setConflictList] = useState<{ source: string; existingName: string }[]>([]);
const [conflictActions, setConflictActions] = useState<Record<string, string>>({});
const [deleteModalOpen, setDeleteModalOpen] = useState(false);
const [deleteProgressOpen, setDeleteProgressOpen] = useState(false);
const [deleteProgress, setDeleteProgress] = useState<import("./types").Progress | null>(null);
const [deleteError, setDeleteError] = useState<string | null>(null);
```

- [ ] **Step 2: Add add/delete progress listener**

Add after the existing compress progress useEffect (around line 122):

```typescript
useEffect(() => {
  const unlistenPromise = onCompressProgress((p) => {
    if (addProgressOpen) setAddProgress(p);
    if (deleteProgressOpen) setDeleteProgress(p);
  });
  return () => { unlistenPromise.then((un) => un()); };
}, [addProgressOpen, deleteProgressOpen]);
```

- [ ] **Step 3: Add buttons to the actions row**

In the JSX, after the `<button className="compress-btn">` and before `<div className="split-button">`:

```tsx
<button
  className="add-btn"
  onClick={() => { setAddSources([]); setAddModalOpen(true); }}
  disabled={!archivePath?.toLowerCase().endsWith('.zip')}
  title={archivePath?.toLowerCase().endsWith('.zip')
    ? "Add files to this archive" : "Only supported for ZIP archives"}
>➕ Add files</button>
<button
  className="delete-btn"
  onClick={() => setDeleteModalOpen(true)}
  disabled={!archivePath?.toLowerCase().endsWith('.zip')}
  title={!archivePath?.toLowerCase().endsWith('.zip')
    ? "Only supported for ZIP archives" : "Select files to delete from archive"}
>🗑 Delete</button>
```

- [ ] **Step 4: Add hasSelection check for delete**

The delete button stays enabled when the archive is ZIP — the modal will show the warning if nothing is selected.

- [ ] **Step 5: Verify compilation**

```bash
cd src && npx tsc --noEmit 2>&1
```

---

### Task 6: Frontend — `AddToArchiveModal` component

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `AddToArchiveModal` component before `DestPickerModal` (around line 1050)**

```tsx
function AddToArchiveModal({
  sources,
  onAddFiles,
  onAddFolder,
  onRemoveSource,
  onStart,
  onCancel,
}: {
  sources: string[];
  onAddFiles: () => void;
  onAddFolder: () => void;
  onRemoveSource: (idx: number) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal-box add-to-archive-box">
        <div className="modal-title">Add files to archive</div>

        <div className="cc-sources-title">
          {sources.length} source{sources.length !== 1 ? "s" : ""}
        </div>
        <div className="cc-sources-list">
          {sources.map((s, i) => (
            <div key={s + i} className="cc-source-item">
              <span className="cc-source-icon">{s.endsWith("\\") || !s.includes(".") ? "📁" : "📄"}</span>
              <span className="cc-source-path" title={s}>{s.split(/[\\/]/).pop()}</span>
              <button className="cc-source-remove" onClick={() => onRemoveSource(i)}>✕</button>
            </div>
          ))}
        </div>
        <div className="cc-add-btns">
          <button className="cc-add-btn" onClick={onAddFiles}>+ Add files</button>
          <button className="cc-add-btn" onClick={onAddFolder}>+ Add folder</button>
        </div>

        <div className="modal-actions">
          <button className="modal-btn-primary" onClick={onStart} disabled={sources.length === 0}>
            Add to archive
          </button>
          <button className="modal-btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd src && npx tsc --noEmit 2>&1
```

---

### Task 7: Frontend — `ConflictModal` component

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `ConflictModal` component after `AddToArchiveModal`**

```tsx
function ConflictModal({
  conflicts,
  actions,
  onAction,
  onContinue,
  onCancel,
}: {
  conflicts: { source: string; existingName: string }[];
  actions: Record<string, string>;
  onAction: (source: string, action: string) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const [applyAll, setApplyAll] = useState("");
  const allSource = conflicts.map((c) => c.source);

  function applyAllAction(action: string) {
    setApplyAll(action);
    const next: Record<string, string> = {};
    for (const s of allSource) {
      next[s] = action === "rename" ? `rename:${getRename(actions[s] || "", s)}` : action;
    }
    // Set each individually
    for (const [k, v] of Object.entries(next)) {
      onAction(k, v);
    }
  }

  return (
    <div className="modal-backdrop" style={{ zIndex: 210 }}>
      <div className="modal-box conflict-box">
        <div className="modal-title">Name conflicts — {conflicts.length} file(s)</div>

        <div className="conflict-list">
          {conflicts.map((c) => (
            <div key={c.source} className="conflict-row">
              <div className="conflict-name">📄 {c.existingName} already exists</div>
              <div className="conflict-source-label">{c.source.split(/[\\/]/).pop()}</div>
              <div className="conflict-actions">
                {(["overwrite", "skip", "rename"] as const).map((act) => (
                  <button
                    key={act}
                    className={`conflict-act-btn${(actions[c.source] || "").startsWith(act) ? " conflict-act-active" : ""}`}
                    onClick={() => onAction(c.source, act === "rename" ? `rename:${c.existingName.replace(/(\.[^.]+)$/, " (1)$1")}` : act)}
                  >
                    {act === "overwrite" ? "Overwrite" : act === "skip" ? "Skip" : "Rename"}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="conflict-apply-all">
          <label className="conflict-apply-label">Apply same action to all:</label>
          <div className="conflict-apply-btns">
            {(["overwrite", "skip", "rename"] as const).map((act) => (
              <button
                key={act}
                className={`conflict-act-btn${applyAll === act ? " conflict-act-active" : ""}`}
                onClick={() => applyAllAction(act)}
              >
                {act === "overwrite" ? "Overwrite all" : act === "skip" ? "Skip all" : "Rename all"}
              </button>
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <button className="modal-btn-primary" onClick={onContinue}
            disabled={Object.keys(actions).length < conflicts.length}>
            Continue
          </button>
          <button className="modal-btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function getRename(current: string, fallback: string): string {
  if (current.startsWith("rename:")) return current.slice(7);
  const name = fallback.split(/[\\/]/).pop() || "file";
  return name.replace(/(\.[^.]+)$/, " (1)$1");
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd src && npx tsc --noEmit 2>&1
```

---

### Task 8: Frontend — `ConfirmDeleteModal` component

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `ConfirmDeleteModal` component after `ConflictModal`**

```tsx
function ConfirmDeleteModal({
  selectedNodes,
  onConfirm,
  onCancel,
}: {
  selectedNodes: TreeNode[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (selectedNodes.length === 0) {
    return (
      <div className="modal-backdrop">
        <div className="modal-box delete-modal-box">
          <div className="modal-title">No files selected</div>
          <p className="delete-warning-text">Please select one or more files to delete from the archive.</p>
          <div className="modal-actions">
            <button className="modal-btn-primary" onClick={onCancel}>OK</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-box delete-modal-box">
        <div className="modal-title">Delete from archive?</div>
        <p className="delete-warning-text">
          This will permanently remove {selectedNodes.length} file(s) from the archive. This cannot be undone.
        </p>
        <div className="delete-selected-list">
          {selectedNodes.map((n) => (
            <div key={n.path} className="delete-selected-item">
              <span>{n.is_dir ? "📁" : "📄"}</span>
              <span>{n.name}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="modal-btn-danger" onClick={onConfirm}>
            Delete {selectedNodes.length} file{selectedNodes.length !== 1 ? "s" : ""}
          </button>
          <button className="modal-btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd src && npx tsc --noEmit 2>&1
```

---

### Task 9: Frontend — wire everything together

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add handler functions in App component**

Add after `handleQuickCompress` (around line 255):

```typescript
/** Check for name conflicts between new sources and existing archive entries. */
function checkConflicts(sources: string[]): { source: string; existingName: string }[] {
  const existingNames = new Set(collectNodes(tree).map((n) => n.name));
  const conflicts: { source: string; existingName: string }[] = [];
  for (const s of sources) {
    const name = s.split(/[\\/]/).pop() || "";
    if (existingNames.has(name)) {
      conflicts.push({ source: s, existingName: name });
    }
  }
  return conflicts;
}

/** Execute add files to archive. */
async function handleAddToArchive() {
  const conflicts = checkConflicts(addSources);
  if (conflicts.length > 0) {
    setConflictList(conflicts);
    setConflictActions({});
    setConflictModalOpen(true);
    return;
  }
  await executeAdd(newlyAddedFiles());
}

function newlyAddedFiles(): Record<string, string> {
  const res: Record<string, string> = {};
  for (const s of addSources) res[s] = "overwrite";
  return res;
}

async function executeAdd(resolutions: Record<string, string>) {
  if (!archivePath) return;
  setAddModalOpen(false);
  setConflictModalOpen(false);
  setAddError(null);
  setAddProgress({ current_file: "", files_done: 0, files_total: 0 });
  setAddProgressOpen(true);
  try {
    await addFilesToArchive(archivePath, addSources, resolutions);
    // Re-read archive to refresh tree
    await openArchivePath(archivePath, password);
  } catch (e) {
    setAddError(String(e));
  }
}

/** Execute delete entries from archive. */
async function handleDeleteEntries() {
  if (!archivePath || selectedPaths.size === 0) return;
  setDeleteModalOpen(false);
  setDeleteError(null);
  setDeleteProgress({ current_file: "", files_done: 0, files_total: 0 });
  setDeleteProgressOpen(true);
  try {
    const entries = Array.from(selectedPaths);
    await deleteEntries(archivePath, entries);
    setSelectedPaths(new Set());
    lastAnchorRef.current = null;
    await openArchivePath(archivePath, password);
  } catch (e) {
    setDeleteError(String(e));
  }
}
```

- [ ] **Step 2: Add modal JSX at the bottom of the return statement**

Add before the closing `</div>` of `.glass`:

```tsx
{addModalOpen && (
  <AddToArchiveModal
    sources={addSources}
    onAddFiles={async () => {
      const f = await pickFilesForCompress();
      if (f) setAddSources((prev) => [...prev, ...f]);
    }}
    onAddFolder={async () => {
      const f = await pickFolder();
      if (f) setAddSources((prev) => [...prev, f]);
    }}
    onRemoveSource={(idx) => setAddSources((prev) => prev.filter((_, i) => i !== idx))}
    onStart={() => handleAddToArchive()}
    onCancel={() => setAddModalOpen(false)}
  />
)}

{conflictModalOpen && (
  <ConflictModal
    conflicts={conflictList}
    actions={conflictActions}
    onAction={(source, action) => setConflictActions((prev) => ({ ...prev, [source]: action }))}
    onContinue={() => executeAdd(conflictActions)}
    onCancel={() => setConflictModalOpen(false)}
  />
)}

{deleteModalOpen && (
  <ConfirmDeleteModal
    selectedNodes={collectNodes(tree).filter((n) => selectedPaths.has(n.path))}
    onConfirm={() => handleDeleteEntries()}
    onCancel={() => setDeleteModalOpen(false)}
  />
)}

{addProgressOpen && (
  <ExtractionModal
    progress={addProgress}
    error={addError}
    dest={null}
    onClose={() => { setAddProgressOpen(false); setAddProgress(null); setAddError(null); }}
    mode="add"
  />
)}

{deleteProgressOpen && (
  <ExtractionModal
    progress={deleteProgress}
    error={deleteError}
    dest={null}
    onClose={() => { setDeleteProgressOpen(false); setDeleteProgress(null); setDeleteError(null); }}
    mode="delete"
  />
)}
```

- [ ] **Step 3: Update `ExtractionModal` to handle `mode="add"` and `mode="delete"`**

In the `ExtractionModal` component, update the `mode` prop type and the title/status text:

```tsx
mode?: "extract" | "compress" | "add" | "delete";
```

And update the title logic (around line 1133):

```tsx
const isCompress = mode === "compress" || mode === "add" || mode === "delete";
const titleLabel = mode === "add" ? "Adding files" : mode === "delete" ? "Deleting files" : mode === "compress" ? "Compressing" : "Extracting";
```

Then use `titleLabel` in the title:
```tsx
{error
  ? `${titleLabel} failed`
  : done
  ? `${titleLabel} complete`
  : `${titleLabel}…`}
```

And the done status text:
```tsx
{done
  ? (mode === "add" ? `Done — ${progress!.files_total} files added`
    : mode === "delete" ? `Done — ${progress!.files_total} files removed`
    : isCompress ? `Done — ${progress!.files_total} files compressed`
    : `Done — ${progress!.files_total} files extracted`)
  : ...}
```

- [ ] **Step 4: Update Esc handler to include new modals**

Add `addModalOpen`, `conflictModalOpen`, `deleteModalOpen`, `addProgressOpen`, `deleteProgressOpen` to the Esc key handler's dependency list and add close logic.

- [ ] **Step 5: Verify compilation**

```bash
cd src && npx tsc --noEmit 2>&1
```

---

### Task 10: CSS — styles for new components

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Add button styles**

Add at the end of the file:

```css
/* Add / Delete buttons in actions row */
.add-btn,
.delete-btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: #c4b5fd;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}
.add-btn:hover:not(:disabled),
.delete-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.15);
}
.add-btn:disabled,
.delete-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Delete confirmation modal */
.delete-modal-box {
  max-width: 420px;
}
.delete-warning-text {
  font-size: 13px;
  color: #a5b4fc;
  margin: 0 0 12px 0;
  line-height: 1.5;
}
.delete-selected-list {
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 16px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  padding: 6px 0;
}
.delete-selected-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font-size: 12px;
  color: #c4b5fd;
}

/* Danger button (delete confirm) */
.modal-btn-danger {
  padding: 8px 20px;
  border-radius: 8px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.modal-btn-danger:hover {
  background: rgba(239, 68, 68, 0.3);
}

/* Add to archive modal */
.add-to-archive-box {
  max-width: 500px;
}

/* Conflict modal */
.conflict-box {
  max-width: 520px;
}
.conflict-list {
  max-height: 250px;
  overflow-y: auto;
  margin-bottom: 12px;
}
.conflict-row {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.conflict-name {
  font-size: 13px;
  color: #e0e7ff;
  margin-bottom: 4px;
}
.conflict-source-label {
  font-size: 11px;
  color: #818cf8;
  margin-bottom: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conflict-actions {
  display: flex;
  gap: 6px;
}
.conflict-act-btn {
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: #a5b4fc;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.conflict-act-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}
.conflict-act-active {
  background: rgba(167, 139, 250, 0.2);
  border-color: rgba(167, 139, 250, 0.4);
  color: #c4b5fd;
}
.conflict-apply-all {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding-top: 10px;
  margin-bottom: 12px;
}
.conflict-apply-label {
  font-size: 12px;
  color: #818cf8;
  margin-bottom: 6px;
  display: block;
}
.conflict-apply-btns {
  display: flex;
  gap: 6px;
}
```

- [ ] **Step 2: Verify build**

```bash
npm run tauri build 2>&1
```

---

### Task 11: Build and test

- [ ] **Step 1: Run the full build**

```bash
npm run tauri build 2>&1
```

Expected: Build succeeds.

- [ ] **Step 2: Manual testing checklist**

1. Open a ZIP archive → verify "Add files" and "Delete" buttons are visible
2. Open a 7z archive → verify buttons are disabled with tooltip
3. Click "Add files" → select files → verify AddToArchiveModal shows sources
4. Click "Add to archive" → verify progress modal → verify files appear in refreshed tree
5. Add a file with same name as existing → verify ConflictModal appears
6. Test Overwrite / Skip / Rename actions in conflict modal
7. Select files in tree → click "Delete" → verify ConfirmDeleteModal with count
8. Click "Delete N files" → verify progress → verify files removed from tree
9. Deselect all → click "Delete" → verify "No files selected" warning
10. Verify the archive is still valid by opening with external tool
```

---

### Task 12: Commit

- [ ] **Step 1: Commit all changes**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/api.ts src/App.tsx src/App.css
git commit -m "feat: add and delete entries in ZIP archives

- Add 'add_files_to_archive' and 'delete_entries' Tauri commands
- AddToArchiveModal, ConflictModal, ConfirmDeleteModal components
- Add/Delete buttons in actions row with ZIP-only support
- Progress tracking via compress-progress event
- Conflict resolution: Overwrite / Skip / Rename"
```