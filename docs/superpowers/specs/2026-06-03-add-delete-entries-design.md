# Design: Add & Delete Entries in Archive

Date: 2026-06-03
Status: Approved

---

## Overview

Add two buttons to the detail page's action bar: "Add files" and "Delete". These allow users to modify a ZIP archive in-place without leaving the app.

**Scope**: ZIP format only initially. Other formats show the buttons disabled with a tooltip.

---

## Architecture

### Backend (Rust) — Two new Tauri commands

#### `add_files_to_archive`

Two-phase command:

1. **Phase 1 — Conflict check** (no `conflicts` arg): Read existing archive entries, compare with new file names. Return a list of `ConflictEntry { existing_path, new_source_path }` if any names clash. If no conflicts, proceed directly to phase 2.
2. **Phase 2 — Execute** (with `conflicts` map): Create a temp archive, copy all existing entries + add new files (respecting conflict resolutions), then `fs::rename` the temp over the original.

Signature:
```rust
#[tauri::command]
async fn add_files_to_archive(
    app: AppHandle,
    archive_path: String,
    sources: Vec<String>,
    conflicts: Option<HashMap<String, ConflictAction>>,
) -> Result<(), String>;
```

`ConflictAction` enum:
```rust
enum ConflictAction {
    Overwrite,
    Skip,
    Rename(String),  // new name in archive
}
```

#### `delete_entries`

Single-phase command:

1. Expand selected paths: if a directory is selected, collect all its descendants.
2. Read existing archive entries, filter out the deleted paths.
3. Write remaining entries to a temp archive, replace original.

Signature:
```rust
#[tauri::command]
async fn delete_entries(
    app: AppHandle,
    archive_path: String,
    entries: Vec<String>,
) -> Result<(), String>;
```

### Frontend (React/TS) — Three new modals

#### `AddToArchiveModal`
- Reuses the source-list pattern from `CompressConfigModal`
- No format selector, level slider, password field, or destination field
- "Add to archive" button triggers conflict check, then executes

#### `ConflictModal`
- Shows a list of conflicting file names
- Each row: file name + [Overwrite] [Skip] [Rename] action buttons
- "Apply same action to all" checkbox for bulk resolution
- Default action: Skip

#### `ConfirmDeleteModal`
- Two variants based on selection state:
  - **No selection**: Simple warning "No files selected. Please select files to delete." with [OK]
  - **Has selection**: "Delete N file(s)? This cannot be undone." with list of selected names and [Delete N files] [Cancel]

---

## Data Flow

### Add flow:
```
User clicks "Add files"
  → AddToArchiveModal opens
  → User picks files/folders, clicks "Add to archive"
  → invoke("add_files_to_archive", { archive_path, sources })
  → If conflicts returned: show ConflictModal
    → User resolves conflicts, clicks "Continue"
    → invoke("add_files_to_archive", { archive_path, sources, conflicts })
  → Progress modal shows (reuse ExtractionModal mode="compress")
  → On completion: re-read archive tree (listArchive)
```

### Delete flow:
```
User clicks "Delete"
  → If no selection: show warning modal, end
  → If has selection: show ConfirmDeleteModal
  → User clicks "Delete N files"
  → invoke("delete_entries", { archive_path, entries })
  → Progress modal shows
  → On completion: clear selection, re-read archive tree
```

---

## ZIP Implementation Detail

Using the `zip` crate (v2.x):

**Read existing entries:**
```rust
let archive = ZipArchive::new(File::open(&archive_path))?;
for i in 0..archive.len() {
    let entry = archive.by_index(i)?;
    // collect: name, is_dir, compressed data
}
```

**Write new archive:**
```rust
let tmp = archive_path.with_extension(".tmp.zip");
let writer = ZipWriter::new(File::create(&tmp)?);
// Copy existing entries (except deleted ones)
for entry in &existing {
    writer.raw_copy_file(entry.raw_copy_source())?;
}
// Add new files
for source in &sources {
    writer.start_file(name, options)?;
    io::copy(&mut File::open(source)?, &mut writer)?;
}
writer.finish()?;
fs::rename(&tmp, &archive_path)?;
```

**Progress:** Emit via `compress-progress` event (reuse existing event name). Track bytes written during the copy phase.

---

## UI Components

### Action bar layout (detail page only):
```
[Open archive… ▾] [➕ Add files] [🗑 Delete] [⬇ Extract all ▾]
```

### Button states:
- **Add files**: Enabled only for `.zip` archives. Tooltip: "Add files to this archive" / "Only supported for ZIP archives"
- **Delete**: Enabled only for `.zip` archives AND when files are selected. Tooltip: "Delete selected files from archive" / "Only supported for ZIP archives" / "Select files first"

### AddToArchiveModal:
```
┌──────────────────────────────────┐
│  Add files to archive            │
├──────────────────────────────────┤
│  Sources:                        │
│  ┌────────────────────────────┐  │
│  │ 📄 report.pdf              ✕ │  │
│  │ 📁 photos/                 ✕ │  │
│  └────────────────────────────┘  │
│  [+ Add files]  [+ Add folder]   │
│                                  │
│         [Add to archive] [Cancel]│
└──────────────────────────────────┘
```

### ConflictModal:
```
┌──────────────────────────────────┐
│  Name conflicts — 2 file(s)      │
├──────────────────────────────────┤
│  📄 report.pdf already exists    │
│     [Overwrite] [Skip] [Rename]  │
│                                  │
│  📁 photos/ already exists       │
│     [Overwrite] [Skip] [Rename]  │
│                                  │
│  ☐ Apply same action to all      │
│                                  │
│              [Continue] [Cancel] │
└──────────────────────────────────┘
```

### ConfirmDeleteModal (with selection):
```
┌──────────────────────────────────┐
│  Delete from archive?            │
├──────────────────────────────────┤
│  This will permanently remove    │
│  3 file(s) from the archive.     │
│  This cannot be undone.          │
│                                  │
│  Selected:                       │
│  📄 report.pdf                   │
│  📄 notes.txt                    │
│  📁 old-photos/                  │
│                                  │
│       [Delete 3 files] [Cancel]  │
└──────────────────────────────────┘
```

---

## Files to Modify

| File | Change |
|------|--------|
| `src-tauri/src/commands.rs` | Add `add_files_to_archive`, `delete_entries` commands + helper functions |
| `src-tauri/src/lib.rs` | Register new commands |
| `src/api.ts` | Add `addFilesToArchive`, `deleteEntries` API functions |
| `src/App.tsx` | Add buttons, new modal components, state management |
| `src/App.css` | Styles for new modals and buttons |

---

## Error Handling

- **Archive not ZIP**: Commands return "Only ZIP archives are supported for modification"
- **I/O errors**: Surface as human-readable strings
- **Archive corrupted during write**: Temp file approach ensures original is preserved until `rename` succeeds
- **Empty sources**: Frontend validates before calling backend

---

## Testing

- Unit tests: `add_files_to_archive` with no conflicts, with conflicts, with overwrite/skip/rename
- Unit tests: `delete_entries` single file, multiple files, directory with children
- Manual test: Add files to ZIP, verify with external tool
- Manual test: Delete files from ZIP, verify archive integrity
- Manual test: Non-ZIP archive shows disabled buttons