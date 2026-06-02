import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  listArchive,
  extractArchive,
  onExtractProgress,
  pickArchive,
  pickDestination,
  computeDestOptions,
  openPath,
  type DestOptions,
} from "./api";
import type { TreeNode } from "./types";
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

function flatCount(nodes: TreeNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count++;
    count += flatCount(n.children);
  }
  return count;
}

function App() {
  const [archivePath, setArchivePath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<import("./types").Progress | null>(null);
  const [destOptions, setDestOptions] = useState<DestOptions | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const splitRef = useRef<HTMLDivElement>(null);
  const [openAfterExtract, setOpenAfterExtract] = useState(false);
  const lastDestRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

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

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenDrop = win.onDragDropEvent(async (e) => {
      if (e.payload.type === "over") {
        setDragOver(true);
      } else if (e.payload.type === "leave") {
        setDragOver(false);
      } else if (e.payload.type === "drop") {
        setDragOver(false);
        const paths: string[] = (e.payload as { paths?: string[] }).paths ?? [];
        const path = paths[0];
        if (!path) return;
        setError(null);
        setProgress(null);
        setMenuOpen(false);
        setDestOptions(null);
        setExpanded(new Set());
        setLoading(true);
        try {
          const t = await listArchive(path);
          setArchivePath(path);
          setTree(t);
          setDestOptions(await computeDestOptions(path));
        } catch (err) {
          setError(String(err));
          setArchivePath(null);
          setTree([]);
          setDestOptions(null);
        } finally {
          setLoading(false);
        }
      }
    });
    return () => {
      unlistenDrop.then((un) => un());
    };
  }, []);

  useEffect(() => {
    if (!progress || !openAfterExtract || !lastDestRef.current) return;
    if (progress.files_done !== progress.files_total) return;
    openPath(lastDestRef.current).catch(() => {});
  }, [progress, openAfterExtract]);

  async function handleOpen() {
    setError(null);
    setProgress(null);
    setMenuOpen(false);
    setDestOptions(null);
    setExpanded(new Set());
    setLoading(true);
    const path = await pickArchive();
    if (!path) {
      setLoading(false);
      return;
    }
    try {
      const t = await listArchive(path);
      setArchivePath(path);
      setTree(t);
      setDestOptions(await computeDestOptions(path));
    } catch (e) {
      setError(String(e));
      setArchivePath(null);
      setTree([]);
      setDestOptions(null);
    } finally {
      setLoading(false);
    }
  }

  function toggleExpand(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function runExtract(dest: string) {
    lastDestRef.current = dest;
    if (!archivePath) return;
    setError(null);
    try {
      setProgress({ current_file: "", files_done: 0, files_total: flatCount(tree) });
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
  const done = progress !== null && progress.files_done === progress.files_total;
  const extractDisabled = !archivePath || (progress !== null && !done);

  const totalItems = flatCount(tree);

  return (
    <div className="glass">
      {dragOver && <div className="drag-overlay"><span>Drop to open</span></div>}
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
            <label className="open-folder-toggle">
              <input
                type="checkbox"
                checked={openAfterExtract}
                onChange={(e) => setOpenAfterExtract(e.target.checked)}
              />
              Open folder after extract
            </label>
          </div>

          <p className="path">
            {loading ? "⏳ Reading archive…" : `📂 ${archivePath} · ${totalItems} items`}
          </p>
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
            {loading ? (
              <div className="loading">
                <span className="loading-spinner" />
                Reading archive contents…
              </div>
            ) : (
              <table className="entries">
                <tbody>
                  {tree.map((node) => (
                    <EntryRow
                      key={node.path}
                      node={node}
                      depth={0}
                      expanded={expanded}
                      onToggle={toggleExpand}
                    />
                  ))}
                </tbody>
              </table>
            )}
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

function EntryRow({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const paddingLeft = 14 + depth * 16;

  return (
    <>
      <tr
        className={`entry-row ${node.is_dir ? "entry-dir" : "entry-file"}`}
        onClick={() => node.is_dir && onToggle(node.path)}
        style={{ cursor: node.is_dir ? "pointer" : "default" }}
      >
        <td>
          <span className="entry-indent" style={{ paddingLeft: `${paddingLeft}px` }}>
            {node.is_dir ? (
              <span className="entry-toggle">{isOpen ? "▼" : "▶"}</span>
            ) : (
              <span className="entry-toggle entry-toggle-spacer" />
            )}
            <span className="entry-icon">{node.is_dir ? "📁" : "📄"}</span>
            <span className="entry-name">{node.name}</span>
          </span>
        </td>
        <td className="size">
          {node.is_dir ? "—" : formatSize(node.size)}
        </td>
      </tr>
      {node.is_dir &&
        isOpen &&
        node.children.map((child) => (
          <EntryRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

export default App;
