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
