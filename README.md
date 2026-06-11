# azzip

A modern, ad-free archive manager. Clean UI, no bloat. Supports 10+ archive formats with a fast multi-threaded extraction engine.

Built with **Tauri 2** (Rust backend) + **React 19 + TypeScript** (frontend).

<p align="center">
  <img src="assets/icons/icon-z.svg" width="128" height="128" alt="azzip icon">
</p>

## Features

### Archive Formats

| Format | List | Extract | Create | Add / Delete |
|--------|------|---------|--------|---------------|
| ZIP | ✅ | ✅ | ✅ | ✅ |
| 7z | ✅ | ✅ | ✅ | — |
| TAR / GZ / BZ2 / XZ | ✅ | ✅ | — | — |
| RAR | ✅ | ✅ | — | — |

### Core Capabilities

- **Password support** — encrypted ZIP & 7z, saved passwords manager
- **Multi-threaded extraction** — parallel decompression for 4+ files, 10MB+ archives
- **In-archive file browser** — tree view with expand/collapse, real-time byte-level progress
- **Search / filter** — type to filter file list by name (case-insensitive)
- **File preview** — double-click text files or images to preview without extracting
- **Drag-and-drop** — drag files out to extract, drag files in to add to open ZIP
- **Add / Delete entries** — modify ZIP contents with conflict resolution (overwrite/skip/rename)
- **Compression** — create ZIP or 7z archives with configurable level and optional password
- **Keyboard navigation** — ↑↓ Enter Space to browse, Ctrl+A select all, Ctrl+E quick extract, Esc to dismiss
- **Multi-select** — Ctrl+click, Shift+click, Ctrl+A
- **Recent files** — dropdown with clear history
- **Context menu** — right-click to extract or quick-compress selected entries
- **Installer** — MSI + NSIS with optional default-app registration

### Visual

- Frameless window with Win11 Acrylic glass effect (Windows)
- Gradient purple theme with animated progress bar
- Button hover/active effects, rounded selection blocks
- No ads, no bundled software

## Prerequisites

### All Platforms

| Tool | Version | Notes |
|------|---------|-------|
| Rust (stable) | latest | Install via [rustup](https://rustup.rs) |
| Node.js | 18+ | npm included |

### Windows

| Tool | Notes |
|------|-------|
| MSVC C++ Build Tools | "Desktop development with C++" workload in Visual Studio Build Tools, or `winget install Microsoft.VisualStudio.2022.BuildTools` |
| WebView2 Runtime | Ships with Windows 11; [download](https://developer.microsoft.com/microsoft-edge/webview2/) for Windows 10 if missing |
| WiX Toolset v3 | Required for MSI output; `cargo install tauri-cli` installs this automatically. Also available via `winget install WiXToolset.WiXToolset` |
| NSIS | Required for NSIS installer; Tauri downloads this automatically during build |

### macOS

```bash
xcode-select --install   # or install Xcode from the App Store
```

### Linux

```bash
# Ubuntu / Debian
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel

# Arch
sudo pacman -S webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg
```

## Setup

```bash
# 1. Clone
git clone https://github.com/ZZLupus/azzip.git && cd azzip

# 2. Install frontend dependencies
npm install

# 3. Install Tauri CLI (recommended: use the local package)
#    No global install needed — `npm run tauri` uses `@tauri-apps/cli` from devDependencies
```

## Development

```bash
# Start dev server (hot-reload frontend + auto-recompile Rust on changes)
npm run tauri dev
```

- Frontend changes reload instantly via Vite HMR (port 1420)
- Rust changes trigger automatic recompile and restart
- On macOS/Linux, the app runs with system-native decorations (transparent frameless window is Windows-only)

## Build

```bash
npm run tauri build
```

### Output

```
src-tauri/target/release/bundle/
├── msi/azzip_0.1.0_x64_en-US.msi     (Windows, ~4 MB)
├── nsis/azzip_0.1.0_x64-setup.exe    (Windows, ~3 MB)
├── dmg/azzip_0.1.0_x64.dmg           (macOS)
├── deb/azzip_0.1.0_amd64.deb         (Linux)
└── appimage/azzip_0.1.0_amd64.AppImage (Linux)
```

**Build pipeline:**

1. `tsc && vite build` — TypeScript checks + bundles React + CSS into `dist/`
2. `cargo build --release` — compiles Rust backend, embeds `dist/` as compiled assets
3. Bundler — wraps the binary into platform installers (WiX / NSIS / DMG / deb / AppImage)

### Platform-specific build tips

| Platform | Note |
|----------|------|
| **Windows** | Both MSI and NSIS are generated. To skip one: `npm run tauri build -- --bundles nsis` |
| **macOS** | DMG requires running on macOS (App Sandbox). Cross-compilation is not supported. |
| **Linux** | `deb` and `AppImage` targets are built when the required packaging tools are present. |

## Tests

```bash
# Backend unit tests (archive engine: list, extract, zip-slip guard, etc.)
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend typecheck
npx tsc --noEmit
```

## Project Structure

```
azzip/
├── src/                          # React + TypeScript frontend
│   ├── App.tsx                   # Main app — welcome screen, archive browser, modals
│   ├── App.css                   # Glass UI styles, search bar, preview, modals
│   ├── TitleBar.tsx              # Frameless window drag region + controls
│   ├── api.ts                    # Typed wrappers over Tauri invoke / listen / dialog
│   ├── types.ts                  # Shared TS types (TreeNode, Progress)
│   ├── useRecentFiles.ts         # Recent files hook with localStorage persistence
│   └── usePasswordStore.ts       # Password manager hook
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                # Tauri builder, Win11 Acrylic, command registration
│   │   ├── commands.rs           # Tauri commands: list, extract, compress, add, delete, preview
│   │   └── archive/              # Archive engine
│   │       ├── mod.rs            # ArchiveHandler trait, Progress/TreeNode, CJK decoder
│   │       ├── zip.rs            # ZipHandler — list, extract (serial + parallel), extract_entry
│   │       ├── sevenz.rs         # SevenZHandler via system 7-Zip CLI
│   │       ├── tar.rs            # TarHandler with GZ/BZ2/XZ detection
│   │       ├── rar.rs            # RarHandler via system 7-Zip CLI
│   │       └── router.rs         # Format detection by extension + magic bytes
│   ├── capabilities/             # Tauri IPC permission grants
│   ├── installer.nsh             # NSIS custom hooks — file association registration
│   ├── Cargo.toml
│   └── tauri.conf.json           # Window config, bundler settings
├── assets/
│   └── icons/icon-z.svg          # Source SVG for app icon
└── docs/
    ├── TODO.md                   # Feature backlog (shipped / remaining)
    └── superpowers/              # Design specs and implementation plans
```

## Tech Stack

- [Tauri 2](https://tauri.app) — native window, IPC, system dialogs, bundler
- [window-vibrancy](https://github.com/tauri-apps/window-vibrancy) — Win11 Acrylic glass (Windows only)
- React 19 + TypeScript + Vite — UI and bundling
- `zip` 8.6 / `sevenz-rust2` / `tar` / `flate2` — pure-Rust archive engines
- `encoding_rs` — CJK filename auto-detection (GBK fallback)
- `base64` — inline image preview via data URLs

## License

MIT
