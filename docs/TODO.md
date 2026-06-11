# azzip — Feature Backlog

Last updated: 2026-06-11

---

## Already Shipped

- [x] ZIP / 7z / TAR family / GZ / RAR (via system 7-Zip CLI)
- [x] Password support + password manager with saved passwords
- [x] Tree file browser with expand/collapse
- [x] Multi-select (Ctrl+click, Shift+click, Ctrl+A)
- [x] Drag-out to extract single / multiple entries
- [x] Right-click context menu → Extract to… / Quick compress
- [x] Drag-and-drop archive open
- [x] Extraction progress modal with byte-level progress
- [x] Custom destination picker with extract-to-subfolder checkbox
- [x] Recent files dropdown with clear history
- [x] Home button
- [x] Keyboard shortcuts: Ctrl+A (select all), Ctrl+E (quick extract), Esc (close modal)
- [x] List bottom fade mask
- [x] Button hover/active effects, no text selection
- [x] Compression — create zip/7z with format/level/password config, byte-level progress
- [x] Add files to ZIP — conflict resolution (overwrite/skip/rename), raw_copy_file fast path
- [x] Delete entries from ZIP — multi-select delete with confirmation dialog
- [x] Unified button styles — actions row + welcome page consistent look
- [x] Keyboard navigation — up/down Enter Space to browse without mouse
- [x] Multi-threaded ZIP extraction — parallel decompress for 4+ files, 10MB+ archives
- [x] CJK encoding detection — auto-detect GBK for garbled filenames
- [x] Search / filter — type to filter file list by name
- [x] Quick extract selected — Ctrl+E to extract selected entries
- [x] Drag to add — drop files from Explorer into open ZIP archive
- [x] File preview — double-click text files or images for inline preview
- [x] Custom app icon — bold Z with book spine motif
- [x] Installer packaging — MSI + NSIS installer, ~3-4 MB

---

## Optional / Nice to Have

| # | Feature | Why |
| :--- | :--- | :--- |
| 1 | Shell integration | "Open with azzip" in Explorer context menu |
| 2 | Multi-volume archives | .part1.rar / .zip.001 split archives |
| 3 | Archive integrity check | "Test archive" button to verify CRC/checksums |
