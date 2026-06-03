# azzip — Feature Backlog

Last updated: 2026-06-03

---

## Already Shipped

- [x] ZIP / 7z / TAR family / GZ / RAR (via system 7-Zip CLI)
- [x] Password support + password manager with saved passwords
- [x] Tree file browser with expand/collapse
- [x] Multi-select (Ctrl+click, Shift+click, Ctrl+A)
- [x] Drag-out to extract single / multiple entries
- [x] Right-click context menu → Extract to…
- [x] Drag-and-drop archive open
- [x] Extraction progress modal with open-folder action
- [x] Custom destination picker with extract-to-subfolder checkbox
- [x] Recent files dropdown with clear history
- [x] Home button to return to welcome screen
- [x] Keyboard shortcuts: Ctrl+A (select all), Esc (close modal)
- [x] 7z real-time per-file progress
- [x] List bottom fade mask
- [x] Button hover / active effects, no text selection

---

## Todo

### High Value (daily-use features)

- [ ] **File preview** — click a file entry to preview content inline (txt, images, code) without extracting
- [ ] **Search / filter** — type to filter the file list inside an archive
- [ ] **Keyboard navigation** — ↑↓ to move selection, Enter to expand folder, Space to select
- [ ] **Status bar** — bottom bar showing selected N items / total size / total file count
- [ ] **Compression** — create zip/7z from files dragged in or selected via dialog

### Required Before Release

- [ ] **Custom app icon** — replace default Tauri icon with azzip branding
- [ ] **Installer packaging** — build `.msi` / NSIS installer for real distribution

### Optional / Nice to Have

- [ ] **Shell right-click integration** — "Open with azzip" in Windows Explorer context menu
- [ ] **Multi-volume archive support** — `.part1.rar` split archives
- [ ] **Multi-archive batch open** — drag in multiple archives at once
