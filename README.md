# azzip

A modern, ad-free archive manager for Windows. Clean UI, no bloat.

Built with **Tauri 2** (Rust backend) + **React + TypeScript** (frontend).

## Features

- Extract ZIP / 7z / TAR / GZ archives (RAR extract-only)
- Three extract modes: choose folder / extract to same-name folder / extract here
- In-archive file browser with live extraction progress
- Frameless window with Win11 Acrylic glass effect
- No ads, no bundled software, no file-association hijacking on install

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Rust (MSVC toolchain) | stable | Install via [rustup](https://rustup.rs) — choose `x86_64-pc-windows-msvc` |
| MSVC C++ Build Tools | 2019+ | "Desktop development with C++" workload in Visual Studio Build Tools |
| WebView2 Runtime | any | Ships with Windows 11; download from Microsoft if missing |
| Node.js | 18+ | npm included |

## Setup

```powershell
# 1. Install Rust (per-user, no admin needed)
Invoke-WebRequest https://win.rustup.rs/x86_64 -OutFile "$env:TEMP\rustup-init.exe"
& "$env:TEMP\rustup-init.exe" -y --default-toolchain stable --default-host x86_64-pc-windows-msvc

# 2. Install Tauri CLI
cargo install tauri-cli --version "^2.0" --locked

# 3. Install frontend dependencies
npm install
```

## Development

```powershell
# Add cargo to PATH first (each new terminal session)
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

# Start dev server (hot-reload frontend + auto-recompile Rust on changes)
npm run tauri dev
```

Opens the app window. Frontend changes reload instantly; Rust changes trigger a recompile.

> **Note:** `cargo tauri dev` blocks the terminal waiting for the GUI window to close. Use `npm run tauri dev` instead — it goes through the local `@tauri-apps/cli` and handles the process lifecycle correctly.

## Build

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

# Full build — release exe + MSI installer
npm run tauri build

# Faster iteration — exe only, skip the MSI bundler
npm run tauri build -- --no-bundle
```

**What happens under the hood:**

1. **Frontend build** (`tsc && vite build`) — TypeScript-checks and bundles React + CSS into `dist/`
2. **Rust release build** (`cargo build --release`) — compiles the Rust backend and embeds the `dist/` assets directly into the binary at compile time (no external web files at runtime)

**Output:**
```
src-tauri/target/release/azzip.exe        (~10 MB, self-contained)
src-tauri/target/release/bundle/msi/      (MSI installer, full build only)
```

## Tests

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

# Backend unit tests (archive engine: list, extract, zip-slip guard, etc.)
cargo test --manifest-path src-tauri/Cargo.toml --lib

# Frontend typecheck
npx tsc --noEmit
```

## Project Structure

```
azzip/
├── src/                    # React + TypeScript frontend
│   ├── App.tsx             # Main view (empty/working states, extract flow)
│   ├── TitleBar.tsx        # Frameless window controls (drag region, min/close)
│   ├── api.ts              # Typed wrappers over Tauri invoke/listen/dialog/path
│   ├── types.ts            # Shared TS types mirroring Rust DTOs
│   └── App.css             # Glass UI styles
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs          # Tauri builder, Win11 Acrylic setup hook
│   │   ├── commands.rs     # list_archive / extract_archive Tauri commands + DTOs
│   │   └── archive/        # Archive engine (ArchiveHandler trait + ZipHandler)
│   ├── capabilities/       # Tauri IPC permission grants
│   └── tauri.conf.json     # Window config (frameless, transparent, min size)
└── docs/superpowers/       # Design specs and implementation plans
```

## Tech Stack

- [Tauri 2](https://tauri.app) — native window, IPC, system dialogs
- [window-vibrancy](https://github.com/tauri-apps/window-vibrancy) — Win11 Acrylic glass
- React 19 + TypeScript + Vite — UI and bundling
- `zip` / `sevenz-rust2` / `tar` / `flate2` — pure-Rust archive engines (no external DLLs)
