# azzip Frameless Glass UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn azzip's main window into a frameless, transparent (Win11 Acrylic) interface with custom min/close controls, a two-row layout, empty/working states, and an auto-hiding translucent scrollbar.

**Architecture:** Presentation layer only. Tauri window goes `decorations:false` + `transparent:true`; a Windows-only `apply_acrylic` call in the Rust `setup` hook adds the glass effect. The frontend drops its opaque gradient background, splits the window-controls row into a `TitleBar.tsx` component, gates the actions row + content behind empty/working states, and styles a webkit auto-hiding scrollbar. No archive/command logic changes.

**Tech Stack:** Tauri 2.x, `window-vibrancy` (Rust), `@tauri-apps/api/window`, React 19 + TypeScript, CSS (webkit scrollbar pseudo-elements, `backdrop-filter`).

---

## Current state (verified before planning)

- `src-tauri/tauri.conf.json`: window block is `{ "title": "azzip", "width": 800, "height": 600 }`, no decorations/transparent keys. `security.csp` is `null`.
- `src-tauri/src/lib.rs`: builder registers `tauri_plugin_opener` + `tauri_plugin_dialog` and `generate_handler![commands::list_archive, commands::extract_archive]`. There is currently **no `.setup(...)` hook**.
- `src-tauri/capabilities/default.json`: permissions `["core:default", "core:path:default", "opener:default", "dialog:default"]`.
- `src/App.tsx`: single component. Has `formatSize`, state `archivePath/entries/error/progress/destOptions/menuOpen`, `splitRef`, a `.toolbar` header with `<h1>📦 azzip</h1>` + `.actions` (Open button + split Extract button + dropdown), a `.path` line, a `.progress` block, and an `.entries` table. Exports `default App`.
- `src/App.css`: `body` has an opaque `radial-gradient` background; `.entries` has a `1px` border; default scrollbar; `.split-button`/`.dropdown` styles exist.
- `src/api.ts`: exports `listArchive, extractArchive, onExtractProgress, pickArchive, pickDestination, computeDestOptions, DestOptions`. **Do not change.**
- Backend tests: 6 passing. This plan must not break them.

## File Structure (this redesign)

- **Modify** `src-tauri/tauri.conf.json` — frameless + transparent + min size
- **Modify** `src-tauri/Cargo.toml` — add `window-vibrancy`
- **Modify** `src-tauri/src/lib.rs` — `.setup()` hook applying Acrylic on Windows
- **Modify** `src-tauri/capabilities/default.json` — add `core:window:default`
- **Create** `src/TitleBar.tsx` — window-controls row (drag region + minimize/close), single responsibility
- **Modify** `src/App.tsx` — use TitleBar, two-row layout, empty/working states
- **Modify** `src/App.css` — transparent bg, glass panel, frameless, auto-hiding scrollbar, control-button styles

## Environment notes for the implementer

- **PATH:** Before any cargo/rustc command, in the SAME PowerShell invocation: `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"` then the cargo command. npm/npx need no prep.
- **Do NOT run `cargo tauri dev`** — it opens a blocking GUI window. Verify with non-blocking `npm run build` + `cargo build` instead. Interactive GUI verification is done by the controller separately.
- **Branch:** stay on the current branch (`feat/milestone-1-foundation`); do NOT switch.
- **Commit author:** `git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "..."`.
- **No stray files:** keep `git status` clean except intended files; never dump `cargo metadata` into the repo.
- This is a UI/window redesign: most verification is build success + typecheck. There are no new unit tests (Uι glass/drag/transparency is validated manually by the controller). The one hard automated gate is: **all 6 existing backend tests still pass** and **both builds succeed**.

---

## Task 1: Frameless + transparent window config

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Edit the windows block**

Replace the single window object in `app.windows` so it reads exactly:
```json
      {
        "title": "azzip",
        "width": 800,
        "height": 600,
        "minWidth": 480,
        "minHeight": 360,
        "decorations": false,
        "transparent": true
      }
```
Leave everything else in the file unchanged (`productName`, `identifier`, `build`, `security.csp: null`, `bundle`).

- [ ] **Step 2: Verify config is valid JSON + backend still builds**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"; cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: builds with no errors (config schema accepts the new keys).

- [ ] **Step 3: Commit**

```powershell
git add src-tauri/tauri.conf.json
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(window): frameless + transparent window with min size"
```

---

## Task 2: Apply Win11 Acrylic in the Rust setup hook

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the window-vibrancy dependency**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"; cargo add window-vibrancy --manifest-path src-tauri/Cargo.toml
```
Expected: adds `window-vibrancy` to `[dependencies]`.

- [ ] **Step 2: Add a `.setup()` hook that applies Acrylic on Windows**

Replace the entire body of `pub fn run()` in `src-tauri/src/lib.rs` with this (keep the `mod archive;` / `mod commands;` lines and the leading comment above them unchanged):
```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                use window_vibrancy::apply_acrylic;
                if let Some(window) = app.get_webview_window("main") {
                    // Translucent purple tint over the system Acrylic blur.
                    // A failure (older Windows without Acrylic) is non-fatal:
                    // the window simply falls back to its CSS translucency.
                    let _ = apply_acrylic(&window, Some((36, 27, 75, 120)));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_archive,
            commands::extract_archive
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify backend compiles**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"; cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: compiles. If the closure's return type needs annotation, the trailing `Ok(())` with the `Box<dyn Error>` inference from Tauri's setup signature should satisfy it; if the compiler complains about the error type, change `Ok(())` to `Ok::<(), Box<dyn std::error::Error>>(())` is NOT needed — Tauri's `setup` expects `Result<(), Box<dyn Error>>` and bare `Ok(())` infers correctly. Only adjust if the compiler explicitly errors, and document any change.

- [ ] **Step 4: Confirm existing tests still pass**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"; cargo test --manifest-path src-tauri/Cargo.toml --lib
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(window): apply Win11 Acrylic glass in setup hook"
```

---

## Task 3: Add window-control capability

**Files:**
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add `core:window:default` to permissions**

Replace the `permissions` array so the file reads exactly:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:path:default",
    "core:window:default",
    "opener:default",
    "dialog:default"
  ]
}
```

- [ ] **Step 2: Verify the capability schema compiles**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"; cargo build --manifest-path src-tauri/Cargo.toml
```
Expected: builds (capability validated at compile time). If `core:window:default` is rejected, the correct grouped permission for minimize/close in Tauri 2 is `core:window:allow-minimize` + `core:window:allow-close` — if the default set errors, replace `core:window:default` with those two explicit permissions and document it.

- [ ] **Step 3: Commit**

```powershell
git add src-tauri/capabilities/default.json
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(window): grant window control capability for min/close"
```

---

## Task 4: TitleBar component (window-controls row)

**Files:**
- Create: `src/TitleBar.tsx`

- [ ] **Step 1: Create the component**

Create `src/TitleBar.tsx` with exactly:
```tsx
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Frameless window-controls row. Doubles as the window drag region.
 * Left: app name. Right: minimize + close buttons.
 */
export default function TitleBar() {
  const appWindow = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar-name">azzip</span>
      <div className="titlebar-controls">
        <button
          className="winctl"
          onClick={() => appWindow.minimize()}
          aria-label="Minimize"
        >
          ─
        </button>
        <button
          className="winctl winctl-close"
          onClick={() => appWindow.close()}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```powershell
Set-Location "C:\Users\lixinpei1\azzip"; npx tsc --noEmit
```
Expected: no errors (the `@tauri-apps/api/window` import resolves; `App.tsx` doesn't use TitleBar yet but the file must still typecheck standalone).

- [ ] **Step 3: Commit**

```powershell
git add src/TitleBar.tsx
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(ui): add frameless TitleBar with minimize/close"
```

---

## Task 5: Rework App.tsx — TitleBar, two-row layout, empty/working states

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace App.tsx entirely**

Replace `src/App.tsx` with exactly:
```tsx
import { useEffect, useRef, useState } from "react";
import {
  listArchive,
  extractArchive,
  onExtractProgress,
  pickArchive,
  pickDestination,
  computeDestOptions,
  type DestOptions,
} from "./api";
import type { ArchiveEntry, Progress } from "./types";
import TitleBar from "./TitleBar";
import "./App.css";

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
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
  const [destOptions, setDestOptions] = useState<DestOptions | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlistenPromise = onExtractProgress(setProgress);
    return () => {
      unlistenPromise.then((un) => un());
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (splitRef.current && !splitRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  async function handleOpen() {
    setError(null);
    setProgress(null);
    setMenuOpen(false);
    setDestOptions(null);
    const path = await pickArchive();
    if (!path) return;
    try {
      const list = await listArchive(path);
      setArchivePath(path);
      setEntries(list);
      setDestOptions(await computeDestOptions(path));
    } catch (e) {
      setError(String(e));
    }
  }

  async function runExtract(dest: string) {
    if (!archivePath) return;
    setError(null);
    try {
      setProgress({ current_file: "", files_done: 0, files_total: entries.length });
      await extractArchive(archivePath, dest);
    } catch (e) {
      setError(String(e));
      setProgress(null);
    }
  }

  async function handleExtractPick() {
    if (!archivePath) return;
    const dest = await pickDestination();
    if (!dest) return;
    runExtract(dest);
  }

  const pct =
    progress && progress.files_total > 0
      ? Math.round((progress.files_done / progress.files_total) * 100)
      : 0;
  // The backend signals completion when files_done === files_total. For an empty
  // archive that means the single 0/0 progress event, so "Done" shows immediately —
  // which is correct: an empty archive is extracted the instant the operation starts.
  const done = progress !== null && progress.files_done === progress.files_total;
  const extractDisabled = !archivePath || (progress !== null && !done);

  return (
    <div className="glass">
      <TitleBar />

      {archivePath ? (
        <>
          <div className="actions-row">
            <button onClick={handleOpen}>Open archive…</button>
            <div className="split-button" ref={splitRef}>
              <button
                className="split-main"
                onClick={handleExtractPick}
                disabled={extractDisabled}
              >
                ⬇ Extract all
              </button>
              <button
                className="split-arrow"
                onClick={() => setMenuOpen((o) => !o)}
                disabled={extractDisabled}
                aria-label="More extract options"
              >
                ▾
              </button>
              {menuOpen && destOptions && (
                <div className="dropdown">
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      runExtract(destOptions.sameName);
                    }}
                  >
                    Extract to {destOptions.stem}\
                  </button>
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      runExtract(destOptions.here);
                    }}
                  >
                    Extract here
                  </button>
                </div>
              )}
            </div>
          </div>

          <p className="path">📂 {archivePath} · {entries.length} items</p>
          {error && <p className="error">⚠ {error}</p>}

          {progress && (
            <div className="progress">
              <div className="bar">
                <div className="fill" style={{ width: `${pct}%` }} />
              </div>
              <span>{done ? "Done" : `${pct}% — ${progress.current_file}`}</span>
            </div>
          )}

          <div className="entries-scroll">
            <table className="entries">
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i}>
                    <td>{e.is_dir ? "📁" : "📄"} {e.path}</td>
                    <td className="size">{e.is_dir ? "—" : formatSize(e.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="empty">
          <div className="empty-icon">📦</div>
          <div className="empty-title">Drop an archive here</div>
          <div className="empty-or">or</div>
          <button className="empty-open" onClick={handleOpen}>
            Open archive…
          </button>
          {error && <p className="error">⚠ {error}</p>}
        </div>
      )}
    </div>
  );
}

export default App;
```

Note the deliberate changes from the old version: the `.toolbar`/`<h1>` is gone (replaced by `TitleBar`); the actions live in `.actions-row` shown only in the working state; the empty state renders the centered welcome; the table is wrapped in `.entries-scroll` (the scroll container) and its `<thead>` is removed for a cleaner frameless look; the path line now shows item count. Behavior of all three extract paths is unchanged.

- [ ] **Step 2: Typecheck + build**

Run:
```powershell
Set-Location "C:\Users\lixinpei1\azzip"; npx tsc --noEmit; npm run build
```
Expected: tsc no errors; vite build exit 0.

- [ ] **Step 3: Commit**

```powershell
git add src/App.tsx
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "feat(ui): two-row layout with empty/working states, TitleBar"
```

---

## Task 6: Restyle App.css — transparent, glass, frameless, auto-hiding scrollbar

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Replace App.css entirely**

Replace `src/App.css` with exactly:
```css
:root {
  color-scheme: dark;
  --accent-a: #a78bfa;
  --accent-b: #f0abfc;
}

/* Transparent everywhere so the window's Acrylic shows through. */
html,
body,
#root {
  margin: 0;
  height: 100%;
  background: transparent;
  font-family: system-ui, -apple-system, sans-serif;
  color: #e0e7ff;
}

/* The single glass panel filling the frameless window. */
.glass {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: rgba(40, 30, 75, 0.45);
  backdrop-filter: blur(22px);
  overflow: hidden;
}

/* Window-controls row — also the drag region. */
.titlebar {
  display: flex;
  align-items: center;
  height: 34px;
  padding: 0 6px 0 14px;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  user-select: none;
}
.titlebar-name {
  font-size: 10px;
  letter-spacing: 0.6px;
  color: #7d749f;
}
.titlebar-controls {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.winctl {
  -webkit-app-region: no-drag;
  border: none;
  background: transparent;
  color: #9d8fd1;
  font-size: 13px;
  width: 34px;
  height: 26px;
  border-radius: 7px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.winctl:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.winctl-close:hover {
  background: rgba(248, 81, 73, 0.85);
  color: #fff;
}

/* Actions row (working state only). */
.actions-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  flex-shrink: 0;
}
button {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #e0e7ff;
  padding: 8px 14px;
  border-radius: 9px;
  cursor: pointer;
  backdrop-filter: blur(12px);
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Split extract button + dropdown. */
.split-button {
  position: relative;
  display: inline-flex;
  margin-left: auto;
}
.split-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
  color: #1e1b4b;
  font-weight: 600;
  border-color: transparent;
}
.split-main:disabled {
  background: rgba(255, 255, 255, 0.06);
  color: #e0e7ff;
}
.split-arrow {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left: 1px solid rgba(30, 27, 75, 0.25);
  padding-left: 10px;
  padding-right: 10px;
  background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
  color: #1e1b4b;
  font-weight: 600;
  border-color: transparent;
}
.split-arrow:disabled {
  background: rgba(255, 255, 255, 0.06);
  color: #e0e7ff;
}
.dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 200px;
  background: rgba(30, 27, 75, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  backdrop-filter: blur(16px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  padding: 4px;
  z-index: 10;
  display: flex;
  flex-direction: column;
}
.dropdown-item {
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 7px;
  padding: 9px 12px;
  font-size: 12px;
  color: #e0e7ff;
  cursor: pointer;
  white-space: nowrap;
  backdrop-filter: none;
}
.dropdown-item:hover {
  background: rgba(167, 139, 250, 0.18);
}

/* Path + status. */
.path {
  margin: 0;
  padding: 0 14px 6px;
  color: #9d8fd1;
  font-size: 12px;
  word-break: break-all;
  flex-shrink: 0;
}
.error {
  color: #fca5a5;
  padding: 0 14px;
}
.progress {
  padding: 0 14px 8px;
  flex-shrink: 0;
}
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
.progress span {
  font-size: 11px;
  color: #9d8fd1;
}

/* Scroll container: fills remaining height, auto-hiding scrollbar. */
.entries-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 10px 14px;
}
/* Auto-hiding translucent scrollbar (webkit). Transparent by default,
   fades in on hover/scroll of the container. */
.entries-scroll::-webkit-scrollbar {
  width: 6px;
}
.entries-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.entries-scroll::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 99px;
  transition: background 0.25s;
}
.entries-scroll:hover::-webkit-scrollbar-thumb {
  background: rgba(167, 139, 250, 0.5);
}

/* File list — no border, frameless. */
.entries {
  width: 100%;
  border-collapse: collapse;
}
.entries td {
  text-align: left;
  padding: 8px 8px;
  font-size: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.entries .size {
  text-align: right;
  color: #9d8fd1;
}

/* Empty (welcome) state. */
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.empty-icon {
  font-size: 38px;
  opacity: 0.9;
}
.empty-title {
  font-size: 13px;
  color: #e0e7ff;
}
.empty-or {
  font-size: 10px;
  color: #7d749f;
}
.empty-open {
  background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
  color: #1e1b4b;
  font-weight: 600;
  border-color: transparent;
  padding: 9px 20px;
  box-shadow: 0 4px 16px rgba(167, 139, 250, 0.4);
}
```

- [ ] **Step 2: Typecheck + build**

Run:
```powershell
Set-Location "C:\Users\lixinpei1\azzip"; npx tsc --noEmit; npm run build
```
Expected: tsc no errors; vite build exit 0.

- [ ] **Step 3: Commit**

```powershell
git add src/App.css
git -c user.name="azzip" -c user.email="dev@azzip.local" commit -m "style(ui): transparent glass panel, frameless, auto-hiding scrollbar"
```

---

## Task 7: Wrap-up verification

**Files:** none (verification + commit)

- [ ] **Step 1: Full backend test suite (regression)**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"; cargo test --manifest-path src-tauri/Cargo.toml --lib
```
Expected: 6 passed (the redesign must not have touched archive logic).

- [ ] **Step 2: Frontend typecheck + build**

Run:
```powershell
Set-Location "C:\Users\lixinpei1\azzip"; npx tsc --noEmit; npm run build
```
Expected: tsc no errors; vite build exit 0.

- [ ] **Step 3: Release build smoke (confirms Acrylic + window config link)**

Run:
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"; Set-Location "C:\Users\lixinpei1\azzip"; npm run tauri build -- --no-bundle
```
Expected: `Built application at: ...\src-tauri\target\release\azzip.exe`, exit 0. (Controller will launch this exe detached for interactive verification — frameless window, Acrylic glass, drag, minimize/close, empty→working states, three extract paths, auto-hiding scrollbar.)

- [ ] **Step 4: Commit (empty marker)**

```powershell
git add -A
git -c user.name="azzip" -c user.email="dev@azzip.local" commit --allow-empty -m "chore: frameless glass UI complete"
```

---

## Self-Review

**Spec coverage:**
- Remove in-app title row → Task 5 (no more `.toolbar`/`<h1>`), replaced by TitleBar ✓
- Frameless (no system title bar/border) → Task 1 `decorations:false` ✓
- Real transparency + Win11 Acrylic glass → Task 1 `transparent:true` + Task 2 `apply_acrylic` ✓
- Remove old opaque gradient background → Task 6 (`html/body/#root` transparent) ✓
- Custom window controls: minimize + close, NO maximize → Task 4 TitleBar ✓
- Drag region + no-drag on buttons → Task 4 (`data-tauri-drag-region`) + Task 6 (`.winctl { -webkit-app-region: no-drag }`) ✓
- Two-row layout (controls row / actions row) → Task 5 + Task 6 ✓
- Empty (centered welcome) vs working states → Task 5 ✓
- Remove content border → Task 6 (`.entries` has no border) ✓
- Auto-hiding translucent scrollbar → Task 6 (`.entries-scroll` webkit thumb transparent → visible on hover) ✓
- Extract `✕` hover red → Task 6 (`.winctl-close:hover`) ✓
- TitleBar.tsx extracted (code org) → Task 4 ✓
- window-vibrancy dep + platform isolation → Task 2 (`#[cfg(target_os="windows")]`) ✓
- core:window capability → Task 3 ✓
- All three extract paths preserved → Task 5 (handleExtractPick + sameName + here) ✓
- Don't touch archive/commands/api → confirmed: no task modifies them ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases". Tasks 2 and 3 include explicit fallback instructions for the two genuine API-version risks (setup return type, capability name) with "document any change" — these are contingencies, not placeholders; the primary path is fully specified. ✓

**Type/name consistency:** CSS classnames match between Task 5 JSX and Task 6 CSS: `.glass`, `.titlebar`/`.titlebar-name`/`.titlebar-controls`/`.winctl`/`.winctl-close` (Task 4 TitleBar + Task 6 CSS), `.actions-row`, `.split-button`/`.split-main`/`.split-arrow`/`.dropdown`/`.dropdown-item`, `.path`/`.error`/`.progress`/`.bar`/`.fill`, `.entries-scroll`/`.entries`/`.size`, `.empty`/`.empty-icon`/`.empty-title`/`.empty-or`/`.empty-open`. TitleBar default-exported (Task 4) and default-imported (Task 5). `DestOptions.sameName`/`.here`/`.stem` match api.ts. Command/event names untouched. ✓
