import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

function HomeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
      <path d="M1.5 6L6.5 1.5L11.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2.5 5.2V11H5.5V8.5H7.5V11H10.5V5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ChevronDown({ size = 10, strokeWidth = 1.8 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none"
      xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
      <polyline points="2,3.5 5,6.5 8,3.5"
        stroke="currentColor" strokeWidth={strokeWidth}
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
import { usePasswordStore, type SavedPassword } from "./usePasswordStore";
import { useRecentFiles } from "./useRecentFiles";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  listArchive,
  extractArchive,
  onExtractProgress,
  pickArchive,
  pickDestination,
  computeDestOptions,
  openFolder,
  extractEntry,
  extractToTemp,
  dragFileOut,
  compressFiles,
  onCompressProgress,
  pickFilesForCompress,
  pickFolder,
  addFilesToArchive,
  deleteEntries,
  ERR_PASSWORD_REQUIRED,
  ERR_WRONG_PASSWORD,
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
  const pwStore = usePasswordStore();
  const recent = useRecentFiles();
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => { getVersion().then(setAppVersion); }, []);
  const [archivePath, setArchivePath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<import("./types").Progress | null>(null);
  const [destOptions, setDestOptions] = useState<DestOptions | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const splitRef = useRef<HTMLDivElement>(null);
  const openBtnRef = useRef<HTMLDivElement>(null);
  const [recentMenuOpen, setRecentMenuOpen] = useState(false);
  const lastDestRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const internalDragging = useRef(false); // true while an entry is being dragged out
  const [destPickerOpen, setDestPickerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordContext, setPasswordContext] = useState<"list" | "extract">("list");
  const [passwordError, setPasswordError] = useState(false);
  const [pwManagerOpen, setPwManagerOpen] = useState(false);
  const pendingPathRef = useRef<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const lastAnchorRef = useRef<string | null>(null); // last non-shift click path for shift-select
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [entryDestPickerOpen, setEntryDestPickerOpen] = useState(false);
  const ctxNodesRef = useRef<import("./types").TreeNode[]>([]);
  // Compress state
  const [compressConfigOpen, setCompressConfigOpen] = useState(false);
  const [compressSources, setCompressSources] = useState<string[]>([]);
  const [compressProgressOpen, setCompressProgressOpen] = useState(false);
  const [compressProgress, setCompressProgress] = useState<import("./types").Progress | null>(null);
  const [compressError, setCompressError] = useState<string | null>(null);
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
  const [searchQuery, setSearchQuery] = useState("");
  const [quickExtractOpen, setQuickExtractOpen] = useState(false);
  const archivePathRef = useRef(archivePath);
  archivePathRef.current = archivePath;
  const passwordRef = useRef(password);
  passwordRef.current = password;
  const treeRef = useRef(tree);
  treeRef.current = tree;

  useEffect(() => {
    const unlistenPromise = onExtractProgress(setProgress);
    return () => {
      unlistenPromise.then((un) => un());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = onCompressProgress(setCompressProgress);
    return () => {
      unlistenPromise.then((un) => un());
    };
  }, []);

  // Add/Delete progress listener — uses refs to avoid missing events
  // (state-based deps would miss events emitted before React re-renders)
  const addProgressActiveRef = useRef(false);
  const deleteProgressActiveRef = useRef(false);
  useEffect(() => {
    const unlistenPromise = onCompressProgress((p) => {
      if (addProgressActiveRef.current) setAddProgress(p);
      if (deleteProgressActiveRef.current) setDeleteProgress(p);
    });
    return () => { unlistenPromise.then((un) => un()); };
  }, []);

  // Auto-scroll focused row into view
  useEffect(() => {
    if (!focusedPath) return;
    const el = document.querySelector(`tr[data-path="${CSS.escape(focusedPath)}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedPath]);

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Esc — close topmost modal
      if (e.key === "Escape") {
        if (addProgressOpen) { setAddProgressOpen(false); setAddProgress(null); setAddError(null); return; }
        if (deleteProgressOpen) { setDeleteProgressOpen(false); setDeleteProgress(null); setDeleteError(null); return; }
        if (conflictModalOpen) { setConflictModalOpen(false); return; }
        if (addModalOpen) { setAddModalOpen(false); return; }
        if (deleteModalOpen) { setDeleteModalOpen(false); return; }
        if (compressProgressOpen) { setCompressProgressOpen(false); setCompressProgress(null); setCompressError(null); return; }
        if (compressConfigOpen)   { setCompressConfigOpen(false); return; }
        if (pwManagerOpen)        { setPwManagerOpen(false); return; }
        if (passwordModalOpen)    { setPasswordModalOpen(false); return; }
        if (modalOpen && (progress?.files_done === progress?.files_total)) {
          setModalOpen(false); setProgress(null); setExtractError(null); return;
        }
        if (destPickerOpen)       { setDestPickerOpen(false); return; }
        if (entryDestPickerOpen)  { setEntryDestPickerOpen(false); return; }
        if (ctxMenu)              { setCtxMenu(null); return; }
        if (quickExtractOpen)     { setQuickExtractOpen(false); return; }
        if (selectedPaths.size)   { setSelectedPaths(new Set()); return; }
      }
      // Keyboard navigation — only when archive open, no modals, not in an input
      const hasModal = passwordModalOpen || modalOpen || destPickerOpen || entryDestPickerOpen
        || compressConfigOpen || compressProgressOpen || addModalOpen || conflictModalOpen
        || deleteModalOpen || addProgressOpen || deleteProgressOpen || pwManagerOpen
        || quickExtractOpen;
      const inInput = (e.target as HTMLElement)?.tagName === "INPUT";
      if (archivePath && !hasModal && !inInput) {
        const visible = visibleNodes();
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const idx = focusedPath ? visible.findIndex((n) => n.path === focusedPath) : -1;
          let nextIdx: number;
          if (idx === -1) {
            nextIdx = 0;
          } else if (e.key === "ArrowDown") {
            nextIdx = Math.min(idx + 1, visible.length - 1);
          } else {
            nextIdx = Math.max(idx - 1, 0);
          }
          const next = visible[nextIdx];
          if (next) {
            setFocusedPath(next.path);
            if (e.shiftKey) {
              // Shift+arrow: extend selection range
              if (lastAnchorRef.current) {
                const ai = visible.findIndex((n) => n.path === lastAnchorRef.current);
                if (ai !== -1) {
                  const [lo, hi] = ai < nextIdx ? [ai, nextIdx] : [nextIdx, ai];
                  setSelectedPaths(new Set(visible.slice(lo, hi + 1).map((n) => n.path)));
                }
              }
            } else if (!e.ctrlKey && !e.metaKey) {
              setSelectedPaths(new Set([next.path]));
              lastAnchorRef.current = next.path;
            }
          }
          return;
        }
        if (e.key === "Enter" && focusedPath) {
          e.preventDefault();
          const node = collectNodes(tree).find((n) => n.path === focusedPath);
          if (node?.is_dir) {
            toggleExpand(focusedPath);
          }
          return;
        }
        if (e.key === " " && focusedPath) {
          e.preventDefault();
          const node = collectNodes(tree).find((n) => n.path === focusedPath);
          if (node) toggleSelect(node, true, false);
          return;
        }
        // Ctrl+E — quick extract selected entries
        if ((e.ctrlKey || e.metaKey) && e.key === "e" && selectedPaths.size > 0) {
          e.preventDefault();
          setQuickExtractOpen(true);
          return;
        }
      }

      // Ctrl+A — select all visible nodes
      if ((e.ctrlKey || e.metaKey) && e.key === "a" && archivePath) {
        e.preventDefault();
        const all = collectNodes(tree);
        setSelectedPaths(new Set(all.map((n) => n.path)));
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pwManagerOpen, passwordModalOpen, modalOpen, progress, destPickerOpen,
      entryDestPickerOpen, ctxMenu, selectedPaths, archivePath, tree,
      compressProgressOpen, compressConfigOpen, addModalOpen, conflictModalOpen,
      deleteModalOpen, addProgressOpen, deleteProgressOpen,
      quickExtractOpen, focusedPath, expanded]);

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
    if (!recentMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (openBtnRef.current && !openBtnRef.current.contains(e.target as Node)) {
        setRecentMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [recentMenuOpen]);

  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenDrop = win.onDragDropEvent(async (e) => {
      if (internalDragging.current) return;
      if (e.payload.type === "over") {
        setDragOver(true);
      } else if (e.payload.type === "leave") {
        setDragOver(false);
      } else if (e.payload.type === "drop") {
        setDragOver(false);
        const paths: string[] = (e.payload as { paths?: string[] }).paths ?? [];
        if (paths.length === 0) return;

        const currentArchive = archivePathRef.current;
        // Drag to add — when an archive is open and it's a ZIP
        if (currentArchive && currentArchive.toLowerCase().endsWith(".zip")) {
          const conflicts = checkConflicts(paths, treeRef.current);
          setAddSources(paths);
          if (conflicts.length > 0) {
            setConflictList(conflicts);
            setConflictActions({});
            setConflictModalOpen(true);
          } else {
            await executeAdd(paths, newlyAddedFiles(paths));
          }
          return;
        }
        // Drag to open — no archive open, treat first file as the archive
        setMenuOpen(false);
        setDestOptions(null);
        setExpanded(new Set());
        setSelectedPaths(new Set());
        lastAnchorRef.current = null;
        await openArchivePath(paths[0]);
      }
    });
    return () => {
      unlistenDrop.then((un) => un());
    };
  }, []);

  useEffect(() => {
    if (!ctxMenu) return;
    function onDown() { setCtxMenu(null); }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ctxMenu]);

  async function handleExtractEntries(nodes: import("./types").TreeNode[], destDir: string) {
    if (!archivePath) return;
    try {
      await Promise.all(nodes.map((n) => extractEntry(archivePath, n.path, destDir, password)));
      openFolder(destDir);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Open compress config with default sources. */
  async function handleCompress() {
    const files = await pickFilesForCompress();
    if (!files || files.length === 0) return;
    setCompressSources(files);
    setCompressConfigOpen(true);
  }

  /** Execute compression with the given config. */
  async function startCompress(sources: string[], dest: string, format: "zip" | "7z", level: number, pw?: string) {
    setCompressConfigOpen(false);
    setCompressError(null);
    setCompressProgress({ current_file: "", files_done: 0, files_total: 0 });
    setCompressProgressOpen(true);
    try {
      await compressFiles(sources, dest, format, level, pw);
    } catch (e) {
      setCompressError(String(e));
    }
  }

  /** Quick compress: extract selected entries to temp then repack into a new archive. */
  async function handleQuickCompress(nodes: import("./types").TreeNode[]) {
    if (!archivePath) return;
    const tmpBase = (destOptions?.here || "").replace(/\\$/, "");
    const tmpDir = tmpBase + `\\_azzip_${Date.now()}`;
    try {
      for (const n of nodes) {
        await extractEntry(archivePath!, n.path, tmpDir, password);
      }
      // Compress everything extracted into the temp dir
      setCompressSources([tmpDir]);
      setCompressConfigOpen(true);
    } catch (e) {
      setError(String(e));
    }
  }

  function checkConflicts(sources: string[], nodes: TreeNode[]): { source: string; existingName: string }[] {
    const existingNames = new Set(collectNodes(nodes).map((n) => n.name));
    const conflicts: { source: string; existingName: string }[] = [];
    for (const s of sources) {
      const name = s.split(/[\\/]/).pop() || "";
      if (existingNames.has(name)) conflicts.push({ source: s, existingName: name });
    }
    return conflicts;
  }

  async function handleAddToArchive() {
    const conflicts = checkConflicts(addSources, tree);
    if (conflicts.length > 0) { setConflictList(conflicts); setConflictActions({}); setConflictModalOpen(true); return; }
    await executeAdd(addSources, newlyAddedFiles(addSources));
  }

  function newlyAddedFiles(sources: string[]): Record<string, string> { const res: Record<string, string> = {}; for (const s of sources) res[s] = "overwrite"; return res; }

  async function executeAdd(sources: string[], resolutions: Record<string, string>) {
    const path = archivePathRef.current;
    if (!path) return;
    setAddModalOpen(false); setConflictModalOpen(false); setAddError(null);
    setAddProgress({ current_file: "", files_done: 0, files_total: 0 }); setAddProgressOpen(true);
    addProgressActiveRef.current = true;
    try { await addFilesToArchive(path, sources, resolutions); await openArchivePath(path, passwordRef.current); }
    catch (e) { setAddError(String(e)); }
    finally { addProgressActiveRef.current = false; }
  }

  async function handleDeleteEntries() {
    if (!archivePath || selectedPaths.size === 0) return;
    setDeleteModalOpen(false); setDeleteError(null);
    setDeleteProgress({ current_file: "", files_done: 0, files_total: 0 }); setDeleteProgressOpen(true);
    deleteProgressActiveRef.current = true;
    try { const entries = Array.from(selectedPaths); await deleteEntries(archivePath, entries); setSelectedPaths(new Set()); lastAnchorRef.current = null; await openArchivePath(archivePath, password); }
    catch (e) { setDeleteError(String(e)); }
    finally { deleteProgressActiveRef.current = false; }
  }

  /** Collect visible (respecting expanded state) nodes in display order. */
  function visibleNodes(): import("./types").TreeNode[] {
    function walk(nodes: import("./types").TreeNode[]): import("./types").TreeNode[] {
      const result: import("./types").TreeNode[] = [];
      for (const n of nodes) {
        result.push(n);
        if (n.is_dir && expanded.has(n.path)) {
          result.push(...walk(n.children));
        }
      }
      return result;
    }
    return walk(displayTree);
  }

  /** Filter tree by search query (case-insensitive substring match on name).
   *  Preserves parent folders whose children match. */
  function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
    if (!q.trim()) return nodes;
    const lower = q.toLowerCase();
    function matches(n: TreeNode): boolean {
      if (n.name.toLowerCase().includes(lower)) return true;
      return n.children.some(matches);
    }
    return nodes
      .filter(matches)
      .map((n) => {
        if (!n.is_dir) return n;
        const filtered = filterTree(n.children, q);
        return { ...n, children: filtered };
      });
  }

  function toggleSelect(node: import("./types").TreeNode, multi: boolean, shift: boolean) {
    if (shift && lastAnchorRef.current) {
      const visible = visibleNodes();
      const a = visible.findIndex((n) => n.path === lastAnchorRef.current);
      const b = visible.findIndex((n) => n.path === node.path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedPaths(new Set(visible.slice(lo, hi + 1).map((n) => n.path)));
        return;
      }
    }
    // Ctrl+click: toggle this one
    if (multi) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        next.has(node.path) ? next.delete(node.path) : next.add(node.path);
        return next;
      });
      lastAnchorRef.current = node.path;
      return;
    }
    // Plain click: select only this one
    setSelectedPaths((prev) => {
      if (prev.size === 1 && prev.has(node.path)) return new Set(); // click same → deselect
      return new Set([node.path]);
    });
    lastAnchorRef.current = node.path;
  }

  async function openArchivePath(path: string, pw?: string) {
    setError(null);
    setProgress(null);
    setLoading(true);
    try {
      const t = await listArchive(path, pw);
      setArchivePath(path);
      setTree(t);
      setPassword(pw);
      setDestOptions(await computeDestOptions(path));
      recent.push(path);
    } catch (e) {
      const msg = String(e);
      if (msg.includes(ERR_PASSWORD_REQUIRED)) {
        pendingPathRef.current = path;
        setPasswordContext("list");
        setPasswordError(false);
        setPasswordModalOpen(true);
      } else if (msg.includes(ERR_WRONG_PASSWORD)) {
        pendingPathRef.current = path;
        setPasswordContext("list");
        setPasswordError(true);
        setPasswordModalOpen(true);
      } else {
        setError(msg);
        setArchivePath(null);
        setTree([]);
        setDestOptions(null);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleHome() {
    setArchivePath(null);
    setTree([]);
    setDestOptions(null);
    setError(null);
    setPassword(undefined);
    setSelectedPaths(new Set());
    setExpanded(new Set());
    setSearchQuery("");
    lastAnchorRef.current = null;
    setCompressConfigOpen(false);
    setCompressProgressOpen(false);
  }

  async function handleOpen() {
    setMenuOpen(false);
    setRecentMenuOpen(false);
    setExpanded(new Set());
    setLoading(true);
    const path = await pickArchive();
    if (!path) {
      setLoading(false);
      return;
    }
    setDestOptions(null);
    await openArchivePath(path);
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

  async function runExtract(dest: string, pw?: string) {
    lastDestRef.current = dest;
    if (!archivePath) return;
    setExtractError(null);
    setProgress({ current_file: "", files_done: 0, files_total: flatCount(tree) });
    setModalOpen(true);
    try {
      await extractArchive(archivePath, dest, pw ?? password);
    } catch (e) {
      const msg = String(e);
      if (msg.includes(ERR_PASSWORD_REQUIRED)) {
        setModalOpen(false);
        setProgress(null);
        pendingPathRef.current = dest;
        setPasswordContext("extract");
        setPasswordError(false);
        setPasswordModalOpen(true);
      } else if (msg.includes(ERR_WRONG_PASSWORD)) {
        setModalOpen(false);
        setProgress(null);
        pendingPathRef.current = dest;
        setPasswordContext("extract");
        setPasswordError(true);
        setPasswordModalOpen(true);
      } else {
        setExtractError(msg);
      }
    }
  }

  function handleExtractPick() {
    if (!archivePath) return;
    setDestPickerOpen(true);
  }

  const extractDisabled = !archivePath || modalOpen;

  const displayTree = searchQuery.trim() ? filterTree(tree, searchQuery) : tree;
  const totalItems = flatCount(displayTree);

  return (
    <div className="glass">
      {dragOver && <div className="drag-overlay"><span>{archivePath ? "Drop to add" : "Drop to open"}</span></div>}
      <TitleBar />

      {archivePath ? (
        <>
          <div className="actions-row">
            <div className="open-split" ref={openBtnRef}>
              <button className="open-main" onClick={handleOpen}>Open archive</button>
              {recent.recents.length > 0 && (
                <button
                  className="open-arrow"
                  onClick={() => setRecentMenuOpen((o) => !o)}
                  aria-label="Recent archives"
                ><ChevronDown /></button>
              )}
              {recentMenuOpen && (
                <div className="dropdown recent-dropdown">
                  {recent.recents.map((p) => (
                    <button
                      key={p}
                      className="dropdown-item recent-item"
                      onClick={() => { setRecentMenuOpen(false); openArchivePath(p); }}
                      title={p}
                    >
                      <span className="recent-name">{p.split(/[\\/]/).pop()}</span>
                      <span className="recent-dir">{p.split(/[\\/]/).slice(0, -1).join("\\")}</span>
                    </button>
                  ))}
                  <div className="dropdown-divider" />
                  <button
                    className="dropdown-item recent-clear"
                    onClick={() => { recent.clear(); setRecentMenuOpen(false); }}
                  >
                    清除历史记录
                  </button>
                </div>
              )}
            </div>
            <button className="compress-btn" onClick={handleCompress}>➕ Compress</button>
            <button className="add-btn" onClick={() => { setAddSources([]); setAddModalOpen(true); }} disabled={!archivePath?.toLowerCase().endsWith('.zip')} title={archivePath?.toLowerCase().endsWith('.zip') ? "Add files to this archive" : "Only supported for ZIP archives"}>➕ Add files</button>
            <button className="delete-btn" onClick={() => setDeleteModalOpen(true)} disabled={!archivePath?.toLowerCase().endsWith('.zip')} title={!archivePath?.toLowerCase().endsWith('.zip') ? "Only supported for ZIP archives" : "Select files to delete from archive"}>🗑 Delete</button>
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
                <ChevronDown />
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

          <p className="path">
            {loading ? "⏳ Reading archive…" : `📂 ${archivePath}${searchQuery ? ` · ${totalItems} of ${flatCount(tree)} items` : ` · ${totalItems} items`}`}
          </p>
          {error && <p className="error">⚠ {error}</p>}

          <div className="search-bar">
            <span className="search-icon">🔍</span>
            <input
              className="search-input"
              type="text"
              placeholder="Filter files…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearchQuery(""); }}
            />
            {searchQuery && (
              <button className="search-clear" onClick={() => setSearchQuery("")} title="Clear">✕</button>
            )}
          </div>

          <div className="entries-wrap">
          <div className="entries-scroll">
            {loading ? (
              <div className="loading">
                <span className="loading-spinner" />
                Reading archive contents…
              </div>
            ) : displayTree.length === 0 ? (
              <div className="no-results">No files matching "{searchQuery}"</div>
            ) : (
              <table className="entries">
                <tbody>
                  {displayTree.map((node) => (
                    <EntryRow
                      key={node.path}
                      node={node}
                      depth={0}
                      expanded={expanded}
                      onToggle={toggleExpand}
                      archivePath={archivePath}
                      password={password}
                      selectedPaths={selectedPaths}
                      onSelect={(n, multi, shift) => toggleSelect(n, multi, shift)}
                      internalDraggingRef={internalDragging}
                      onContextMenu={(e, n) => {
                        e.preventDefault();
                        if (selectedPaths.has(n.path)) {
                          ctxNodesRef.current = collectNodes(displayTree).filter((nd) => selectedPaths.has(nd.path));
                        } else {
                          ctxNodesRef.current = [n];
                          setSelectedPaths(new Set([n.path]));
                        }
                        setCtxMenu({ x: e.clientX, y: e.clientY });
                      }}
                      focusedPath={focusedPath}
                      onFocus={setFocusedPath}
                      onDragExtract={(nodes) => {
                        if (nodes.length === 0 || (nodes.length === 1 && selectedPaths.has(nodes[0].path) && selectedPaths.size > 1)) {
                          ctxNodesRef.current = collectNodes(displayTree).filter((n) => selectedPaths.has(n.path));
                        } else {
                          ctxNodesRef.current = nodes;
                        }
                        setEntryDestPickerOpen(true);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          </div>
        </>
      ) : (
        <div className="empty">
          <div className="empty-icon">📦</div>
          <div className="empty-title">Drop an archive here</div>
          <div className="empty-or">or</div>
          <div className="open-split empty-open-split" ref={openBtnRef}>
            <button className="empty-open open-main" onClick={handleOpen}>
              Open archive
            </button>
            {recent.recents.length > 0 && (
              <button
                className="empty-open open-arrow"
                onClick={() => setRecentMenuOpen((o) => !o)}
                aria-label="Recent archives"
              ><ChevronDown /></button>
            )}
            {recentMenuOpen && (
              <div className="dropdown recent-dropdown">
                {recent.recents.map((p) => (
                  <button
                    key={p}
                    className="dropdown-item recent-item"
                    onClick={() => { setRecentMenuOpen(false); openArchivePath(p); }}
                    title={p}
                  >
                    <span className="recent-name">{p.split(/[\\/]/).pop()}</span>
                    <span className="recent-dir">{p.split(/[\\/]/).slice(0, -1).join("\\")}</span>
                  </button>
                ))}
                <div className="dropdown-divider" />
                <button
                  className="dropdown-item recent-clear"
                  onClick={() => { recent.clear(); setRecentMenuOpen(false); }}
                >
                  清除历史记录
                </button>
              </div>
            )}
          </div>
          <div className="empty-compress-row">
            <button className="empty-compress-btn" onClick={handleCompress}>➕ Compress files</button>
          </div>
          {error && <p className="error">⚠ {error}</p>}
        </div>
      )}

      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="ctx-label">
            {ctxNodesRef.current.length > 1
              ? `${ctxNodesRef.current.length} items selected`
              : ctxNodesRef.current[0]?.name}
          </div>
          <button className="ctx-item" onClick={() => {
            setCtxMenu(null);
            setEntryDestPickerOpen(true);
          }}>
            ⬇ Extract to…
          </button>
          <button className="ctx-item" onClick={() => {
            const nodes = ctxNodesRef.current;
            setCtxMenu(null);
            handleQuickCompress(nodes);
          }}>
            📦 Quick compress to…
          </button>
        </div>
      )}

      {entryDestPickerOpen && destOptions && ctxNodesRef.current.length > 0 && (
        <DestPickerModal
          destOptions={destOptions}
          onConfirm={(dest) => {
            setEntryDestPickerOpen(false);
            handleExtractEntries(ctxNodesRef.current, dest);
          }}
          onCancel={() => setEntryDestPickerOpen(false)}
        />
      )}

      {quickExtractOpen && destOptions && selectedPaths.size > 0 && (
        <DestPickerModal
          destOptions={destOptions}
          onConfirm={(dest) => {
            setQuickExtractOpen(false);
            const selectedNodes = collectNodes(displayTree).filter((n) => selectedPaths.has(n.path));
            handleExtractEntries(selectedNodes, dest);
          }}
          onCancel={() => setQuickExtractOpen(false)}
        />
      )}

      {passwordModalOpen && (
        <PasswordModal
          wrongPassword={passwordError}
          savedPasswords={pwStore.passwords}
          onConfirm={(pw) => {
            setPasswordModalOpen(false);
            if (passwordContext === "list" && pendingPathRef.current) {
              openArchivePath(pendingPathRef.current, pw);
            } else if (passwordContext === "extract" && pendingPathRef.current) {
              setPassword(pw);
              runExtract(pendingPathRef.current, pw);
            }
          }}
          onCancel={() => setPasswordModalOpen(false)}
          onOpenManager={() => setPwManagerOpen(true)}
        />
      )}

      {pwManagerOpen && (
        <PasswordManagerModal
          passwords={pwStore.passwords}
          onAdd={pwStore.add}
          onUpdate={pwStore.update}
          onRemove={pwStore.remove}
          onClose={() => setPwManagerOpen(false)}
        />
      )}

      {destPickerOpen && destOptions && (
        <DestPickerModal
          destOptions={destOptions}
          onConfirm={(dest) => { setDestPickerOpen(false); runExtract(dest); }}
          onCancel={() => setDestPickerOpen(false)}
        />
      )}

      {modalOpen && (
        <ExtractionModal
          progress={progress}
          error={extractError}
          dest={lastDestRef.current}
          onClose={() => { setModalOpen(false); setProgress(null); setExtractError(null); }}
          mode="extract"
        />
      )}

      {compressConfigOpen && (
        <CompressConfigModal
          sources={compressSources}
          onAddFiles={async () => {
            const f = await pickFilesForCompress();
            if (f) setCompressSources((prev) => [...prev, ...f]);
          }}
          onAddFolder={async () => {
            const f = await pickFolder();
            if (f) setCompressSources((prev) => [...prev, f]);
          }}
          onRemoveSource={(idx) => setCompressSources((prev) => prev.filter((_, i) => i !== idx))}
          onStart={(dest, format, level, pw) => startCompress(compressSources, dest, format, level, pw)}
          onCancel={() => setCompressConfigOpen(false)}
        />
      )}

      {compressProgressOpen && (
        <ExtractionModal
          progress={compressProgress}
          error={compressError}
          dest={null}
          onClose={() => { setCompressProgressOpen(false); setCompressProgress(null); setCompressError(null); }}
          mode="compress"
        />
      )}

      {archivePath && (
        <button className="home-btn" onClick={handleHome} title="Back to home">
          <HomeIcon />
        </button>
      )}

      {appVersion && (
        <span className="app-version-badge">v{appVersion}</span>
      )}

      {addModalOpen && (
        <AddToArchiveModal sources={addSources}
          onAddFiles={async () => { const f = await pickFilesForCompress(); if (f) setAddSources((prev) => [...prev, ...f]); }}
          onAddFolder={async () => { const f = await pickFolder(); if (f) setAddSources((prev) => [...prev, f]); }}
          onRemoveSource={(idx) => setAddSources((prev) => prev.filter((_, i) => i !== idx))}
          onStart={() => handleAddToArchive()} onCancel={() => setAddModalOpen(false)} />
      )}
      {conflictModalOpen && (
        <ConflictModal conflicts={conflictList} actions={conflictActions}
          onAction={(source, action) => setConflictActions((prev) => ({ ...prev, [source]: action }))}
          onContinue={() => executeAdd(addSources, conflictActions)} onCancel={() => setConflictModalOpen(false)} />
      )}
      {deleteModalOpen && (
        <ConfirmDeleteModal selectedNodes={collectNodes(tree).filter((n) => selectedPaths.has(n.path))}
          onConfirm={() => handleDeleteEntries()} onCancel={() => setDeleteModalOpen(false)} />
      )}
      {addProgressOpen && (
        <ExtractionModal progress={addProgress} error={addError} dest={null}
          onClose={() => { setAddProgressOpen(false); setAddProgress(null); setAddError(null); }} mode="add" />
      )}
      {deleteProgressOpen && (
        <ExtractionModal progress={deleteProgress} error={deleteError} dest={null}
          onClose={() => { setDeleteProgressOpen(false); setDeleteProgress(null); setDeleteError(null); }} mode="delete" />
      )}
    </div>
  );
}

function PasswordModal({
  wrongPassword,
  savedPasswords,
  onConfirm,
  onCancel,
  onOpenManager,
}: {
  wrongPassword: boolean;
  savedPasswords: SavedPassword[];
  onConfirm: (pw: string) => void;
  onCancel: () => void;
  onOpenManager: () => void;
}) {
  const [pw, setPw] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    function onDown(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node))
        setDropdownOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dropdownOpen]);

  function submit() {
    if (pw.trim()) onConfirm(pw);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-box">
        <div className="modal-title-row">
          <span className="modal-title">Password required</span>
          <button className="pw-manager-btn" onClick={onOpenManager}>
            🔑 Password manager
          </button>
        </div>
        {wrongPassword && (
          <p className="modal-error">⚠ Incorrect password, please try again.</p>
        )}
        <div className="pw-input-row" ref={dropRef}>
          <input
            className="password-input pw-input-field"
            type="password"
            placeholder="Enter password…"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            autoFocus
          />
          {savedPasswords.length > 0 && (
            <>
              <button
                className="pw-dropdown-btn"
                onClick={() => setDropdownOpen((o) => !o)}
                title="Saved passwords"
              ><ChevronDown /></button>
              {dropdownOpen && (
                <div className="pw-dropdown">
                  {savedPasswords.map((s) => (
                    <button
                      key={s.id}
                      className="pw-dropdown-item"
                      onClick={() => { setPw(s.value); setDropdownOpen(false); }}
                    >
                      <span className="pw-dropdown-label">{s.label}</span>
                      <span className="pw-dropdown-dots">••••••</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-actions">
          <button className="modal-btn-primary" onClick={submit} disabled={!pw.trim()}>
            Unlock
          </button>
          <button className="modal-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function PasswordManagerModal({
  passwords,
  onAdd,
  onUpdate,
  onRemove,
  onClose,
}: {
  passwords: SavedPassword[];
  onAdd: (label: string, value: string) => void;
  onUpdate: (id: string, label: string, value: string) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editValue, setEditValue] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [showValues, setShowValues] = useState<Set<string>>(new Set());

  function startEdit(p: SavedPassword) {
    setEditingId(p.id);
    setEditLabel(p.label);
    setEditValue(p.value);
  }

  function saveEdit() {
    if (editingId && editLabel.trim() && editValue.trim()) {
      onUpdate(editingId, editLabel.trim(), editValue.trim());
      setEditingId(null);
    }
  }

  function addNew() {
    if (newLabel.trim() && newValue.trim()) {
      onAdd(newLabel.trim(), newValue.trim());
      setNewLabel("");
      setNewValue("");
    }
  }

  function toggleShow(id: string) {
    setShowValues((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="modal-backdrop" style={{ zIndex: 300 }}>
      <div className="modal-box pw-manager-box">
        <div className="modal-title-row">
          <span className="modal-title">Password manager</span>
          <button className="pw-manager-close" onClick={onClose}>✕</button>
        </div>

        {/* Saved passwords list */}
        <div className="pw-list">
          {passwords.length === 0 && (
            <p className="pw-list-empty">No saved passwords yet.</p>
          )}
          {passwords.map((p) => (
            <div key={p.id} className="pw-list-item">
              {editingId === p.id ? (
                <>
                  <input className="pw-edit-input" value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)} placeholder="Label" />
                  <input className="pw-edit-input" type="password" value={editValue}
                    onChange={(e) => setEditValue(e.target.value)} placeholder="Password"
                    onKeyDown={(e) => e.key === "Enter" && saveEdit()} />
                  <button className="pw-act-save" onClick={saveEdit}>Save</button>
                  <button className="pw-act-cancel" onClick={() => setEditingId(null)}>✕</button>
                </>
              ) : (
                <>
                  <span className="pw-item-label">{p.label}</span>
                  <span className="pw-item-value">
                    {showValues.has(p.id) ? p.value : "••••••"}
                  </span>
                  <button className="pw-act-show" onClick={() => toggleShow(p.id)}
                    title={showValues.has(p.id) ? "Hide" : "Show"}>
                    {showValues.has(p.id) ? "🙈" : "👁"}
                  </button>
                  <button className="pw-act-edit" onClick={() => startEdit(p)}>Edit</button>
                  <button className="pw-act-del" onClick={() => onRemove(p.id)}>Delete</button>
                </>
              )}
            </div>
          ))}
        </div>

        {/* Add new */}
        <div className="pw-add-row">
          <input className="pw-add-input" value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)} placeholder="Label (e.g. Work archive)" />
          <input className="pw-add-input" type="password" value={newValue}
            onChange={(e) => setNewValue(e.target.value)} placeholder="Password"
            onKeyDown={(e) => e.key === "Enter" && addNew()} />
          <button className="modal-btn-primary pw-add-btn"
            onClick={addNew} disabled={!newLabel.trim() || !newValue.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function CompressConfigModal({
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
  onStart: (dest: string, format: "zip" | "7z", level: number, pw?: string) => void;
  onCancel: () => void;
}) {
  const firstSrc = sources[0] || "";
  const defaultDir = firstSrc ? firstSrc.replace(/[\\/][^\\/]*$/, "") : "";
  const defaultName = firstSrc
    ? (firstSrc.split(/[\\/]/).pop() || "archive") + ".zip"
    : "archive.zip";

  const [dest, setDest] = useState(defaultDir ? `${defaultDir}\\${defaultName}` : defaultName);
  const [format, setFormat] = useState<"zip" | "7z">("zip");
  const [level, setLevel] = useState(5);
  const [pw, setPw] = useState("");

  const levelLabel = level === 1 ? "Fast" : level === 5 ? "Standard" : level === 9 ? "Maximum" : `Level ${level}`;

  async function browseDest() {
    const picked = await pickDestination();
    if (picked) {
      const ext = format === "zip" ? ".zip" : ".7z";
      const name = firstSrc ? (firstSrc.split(/[\\/]/).pop() || "archive") + ext : "archive" + ext;
      setDest(`${picked}\\${name}`);
    }
  }

  function start() {
    if (sources.length === 0) return;
    onStart(dest, format, level, pw.trim() || undefined);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-box compress-config-box">
        <div className="modal-title">Compress</div>

        {/* Format + Level */}
        <div className="cc-row">
          <label className="cc-label">Format</label>
          <select className="cc-select" value={format} onChange={(e) => {
              const newFmt = e.target.value as "zip" | "7z";
              setFormat(newFmt);
              setDest((prev) => prev.replace(/\.(zip|7z)$/i, `.${newFmt}`));
            }}>
            <option value="zip">ZIP</option>
            <option value="7z">7z</option>
          </select>
        </div>

        <div className="cc-row">
          <label className="cc-label">Level</label>
          <div className="cc-level-row">
            <input
              type="range" min={1} max={9} step={4} value={level}
              onChange={(e) => setLevel(Number(e.target.value))}
              className="cc-slider"
            />
            <span className="cc-level-label">{levelLabel}</span>
          </div>
        </div>

        {/* Password */}
        <div className="cc-row">
          <label className="cc-label">Password</label>
          <input
            className="cc-input"
            type="password"
            placeholder="Optional…"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>

        {/* Destination */}
        <div className="cc-row">
          <label className="cc-label">Save to</label>
          <input
            className="cc-input cc-dest-input"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder="C:\Users\...\archive.zip"
          />
          <button className="cc-browse" onClick={browseDest}>Browse…</button>
        </div>

        {/* Sources */}
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
          <button className="modal-btn-primary" onClick={start} disabled={sources.length === 0}>
            Compress
          </button>
          <button className="modal-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function AddToArchiveModal({
  sources, onAddFiles, onAddFolder, onRemoveSource, onStart, onCancel,
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
        <div className="cc-sources-title">{sources.length} source{sources.length !== 1 ? "s" : ""}</div>
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
          <button className="modal-btn-primary" onClick={onStart} disabled={sources.length === 0}>Add to archive</button>
          <button className="modal-btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ConflictModal({
  conflicts, actions, onAction, onContinue, onCancel,
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
    for (const s of allSource) onAction(s, action === "rename" ? `rename:${getRename(actions[s] || "", s)}` : action);
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
                  <button key={act} className={`conflict-act-btn${(actions[c.source] || "").startsWith(act) ? " conflict-act-active" : ""}`}
                    onClick={() => onAction(c.source, act === "rename" ? `rename:${c.existingName.replace(/(\.[^.]+)$/, " (1)$1")}` : act)}>
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
              <button key={act} className={`conflict-act-btn${applyAll === act ? " conflict-act-active" : ""}`} onClick={() => applyAllAction(act)}>
                {act === "overwrite" ? "Overwrite all" : act === "skip" ? "Skip all" : "Rename all"}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button className="modal-btn-primary" onClick={onContinue} disabled={Object.keys(actions).length < conflicts.length}>Continue</button>
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

function ConfirmDeleteModal({
  selectedNodes, onConfirm, onCancel,
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
          <div className="modal-actions"><button className="modal-btn-primary" onClick={onCancel}>OK</button></div>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop">
      <div className="modal-box delete-modal-box">
        <div className="modal-title">Delete from archive?</div>
        <p className="delete-warning-text">This will permanently remove {selectedNodes.length} file(s) from the archive. This cannot be undone.</p>
        <div className="delete-selected-list">
          {selectedNodes.map((n) => (
            <div key={n.path} className="delete-selected-item"><span>{n.is_dir ? "📁" : "📄"}</span><span>{n.name}</span></div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="modal-btn-danger" onClick={onConfirm}>Delete {selectedNodes.length} file{selectedNodes.length !== 1 ? "s" : ""}</button>
          <button className="modal-btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function DestPickerModal({
  destOptions,
  onConfirm,
  onCancel,
}: {
  destOptions: DestOptions;
  onConfirm: (dest: string) => void;
  onCancel: () => void;
}) {
  const [baseDir, setBaseDir] = useState(destOptions.here);
  const [useStemFolder, setUseStemFolder] = useState(true);

  const finalDest = useStemFolder ? `${baseDir}\\${destOptions.stem}` : baseDir;

  async function browse() {
    const picked = await pickDestination();
    if (picked) setBaseDir(picked);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-box">
        <div className="modal-title">Choose destination</div>

        <div className="dest-row">
          <span className="dest-path" title={baseDir}>{baseDir}</span>
          <button className="dest-browse" onClick={browse}>Browse…</button>
        </div>

        <label className="dest-stem-toggle">
          <input
            type="checkbox"
            checked={useStemFolder}
            onChange={(e) => setUseStemFolder(e.target.checked)}
          />
          Extract into subfolder "<strong>{destOptions.stem}</strong>"
        </label>

        <div className="dest-preview">
          → {finalDest}
        </div>

        <div className="modal-actions">
          <button className="modal-btn-primary" onClick={() => onConfirm(finalDest)}>
            Extract
          </button>
          <button className="modal-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ExtractionModal({
  progress,
  error,
  dest,
  onClose,
  mode = "extract",
}: {
  progress: import("./types").Progress | null;
  error: string | null;
  dest: string | null;
  onClose: () => void;
  mode?: "extract" | "compress" | "add" | "delete";
}) {
  const titleLabel = mode === "add" ? "Adding files" : mode === "delete" ? "Deleting files" : mode === "compress" ? "Compressing" : "Extracting";
  const rawPct = progress
    ? (progress.bytes_total && progress.bytes_total > 0
      ? (progress.bytes_done ?? 0) / progress.bytes_total * 100
      : progress.files_total > 0
      ? progress.files_done / progress.files_total * 100
      : 0)
    : 0;
  const pct = Math.max(0, Math.min(100, Math.round(rawPct * 10) / 10));
  const done = rawPct >= 100 && (progress?.files_total ?? 0) > 0;
  const inProgress = !done && !error;

  return (
    <div className="modal-backdrop">
      <div className="modal-box">
        <div className="modal-title">
          {error
            ? `${titleLabel} failed`
            : done
            ? `${titleLabel} complete`
            : `${titleLabel}…`}
        </div>

        {error ? (
          <p className="modal-error">⚠ {error}</p>
        ) : (
          <>
            <div className="modal-bar-row">
              <div className="modal-bar">
                <div className={`modal-fill${done ? " modal-fill-done" : ""}`} style={{ width: `${rawPct}%`, transition: inProgress ? "width 0.15s ease" : "none" }} />
              </div>
              <span className={`modal-pct${done ? " modal-pct-done" : ""}`}>{pct}%</span>
            </div>
            <div className="modal-status">
              {done
                ? mode === "add" ? `Done — ${progress!.new_files ?? progress!.files_total} file(s) added` : mode === "delete" ? `Done — ${progress!.new_files ?? progress!.files_total} file(s) removed` : mode === "compress" ? `Done — ${progress!.files_total} files compressed` : `Done — ${progress!.files_total} files extracted`
                : progress?.current_file
                ? progress.current_file.split(/[\\/]/).pop()
                : "Starting…"}
            </div>
          </>
        )}

        <div className="modal-actions">
          {(done || error) && dest && !error && (
            <button className="modal-btn-primary" onClick={() => openFolder(dest)}>
              Open folder
            </button>
          )}
          <button
            className={done || error ? "modal-btn-secondary" : "modal-btn-cancel"}
            onClick={onClose}
            disabled={inProgress && !error}
          >
            {inProgress ? "Running…" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}

function collectNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...collectNodes(n.children)]);
}

function EntryRow({
  node,
  depth,
  expanded,
  onToggle,
  archivePath,
  password,
  selectedPaths,
  onSelect,
  onContextMenu,
  onDragExtract,
  internalDraggingRef,
  focusedPath,
  onFocus,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  archivePath: string | null;
  password?: string;
  selectedPaths: Set<string>;
  onSelect: (node: TreeNode, multi: boolean, shift: boolean) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
  onDragExtract: (nodes: TreeNode[]) => void;
  internalDraggingRef: React.MutableRefObject<boolean>;
  focusedPath: string | null;
  onFocus: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPaths.has(node.path);
  const paddingLeft = 14 + depth * 16;
  const [dragging, setDragging] = useState(false);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  const mouseDownRef = useRef(false);
  const dblClickPending = useRef(false);

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;
    mouseDownRef.current = true;
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragStartPos.current || isDragging.current || !archivePath) return;
    const dx = e.clientX - dragStartPos.current.x;
    const dy = e.clientY - dragStartPos.current.y;
    if (Math.sqrt(dx * dx + dy * dy) < 6) return;
    isDragging.current = true;
    dragStartPos.current = null;
    setDragging(true);
    internalDraggingRef.current = true;

    // Drag all selected nodes (or just this one if not selected)
    const dragNodes = isSelected && selectedPaths.size > 1
      ? [] // will resolve via onDragExtract below
      : [node];
    const paths = isSelected && selectedPaths.size > 1
      ? Array.from(selectedPaths)
      : [node.path];

    Promise.all(paths.map((p) => extractToTemp(archivePath, p, password)))
      .then((tmpPaths) => {
        setDragging(false);
        if (mouseDownRef.current) {
          // Mouse still held — fire real OS drag with all files
          Promise.all(tmpPaths.map((tp) => dragFileOut(tp)))
            .catch(() => {})
            .finally(() => { internalDraggingRef.current = false; });
        } else {
          internalDraggingRef.current = false;
          // Released early — open dest picker with the relevant nodes
          if (isSelected && selectedPaths.size > 1) {
            onDragExtract(dragNodes); // will be resolved from selectedPaths in parent
          } else {
            onDragExtract([node]);
          }
        }
      })
      .catch(() => {
        setDragging(false);
        isDragging.current = false;
        internalDraggingRef.current = false;
      });
  }

  function handleMouseUp(e: React.MouseEvent) {
    if (e.button !== 0) return; // ignore right-click / middle-click
    onFocus(node.path);
    mouseDownRef.current = false;
    if (isDragging.current) {
      e.stopPropagation();
      isDragging.current = false;
      return;
    }
    dragStartPos.current = null;
    if (dblClickPending.current) {
      dblClickPending.current = false;
      return; // second mouseup of a dblclick — skip selection toggle
    }
    onSelect(node, e.ctrlKey || e.metaKey, e.shiftKey);
  }

  return (
    <>
      <tr
        data-path={node.path}
        className={`entry-row ${node.is_dir ? "entry-dir" : "entry-file"}${isSelected ? " entry-selected" : ""}${focusedPath === node.path ? " entry-focused" : ""}${dragging ? " entry-dragging" : ""}`}
        onDoubleClick={() => {
          if (!node.is_dir) return;
          dblClickPending.current = true;
          onToggle(node.path);
        }}
        onContextMenu={(e) => onContextMenu(e, node)}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ cursor: dragging ? "grabbing" : "default" }}
        title="Ctrl+click to multi-select · Double-click folder to expand · Drag to extract · Right-click for options"
      >
        <td>
          <span className="entry-indent" style={{ paddingLeft: `${paddingLeft}px` }}>
            {node.is_dir ? (
              <span
                className={`entry-toggle entry-toggle-arrow${isOpen ? " entry-toggle-open" : ""}`}
                onClick={(e) => { e.stopPropagation(); onToggle(node.path); }}
                onDoubleClick={(e) => e.stopPropagation()}
              ><ChevronDown size={10} strokeWidth={1.8} /></span>
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
            archivePath={archivePath}
            password={password}
            selectedPaths={selectedPaths}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            onDragExtract={onDragExtract}
            internalDraggingRef={internalDraggingRef}
            focusedPath={focusedPath}
            onFocus={onFocus}
          />
        ))}
    </>
  );
}

export default App;
