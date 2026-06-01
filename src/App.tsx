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
