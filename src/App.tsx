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
  const lastAnchorRef = useRef<string | null>(null); // last non-shift click path for shift-select
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [entryDestPickerOpen, setEntryDestPickerOpen] = useState(false);
  const ctxNodesRef = useRef<import("./types").TreeNode[]>([]);

  useEffect(() => {
    const unlistenPromise = onExtractProgress(setProgress);
    return () => {
      unlistenPromise.then((un) => un());
    };
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Esc — close topmost modal
      if (e.key === "Escape") {
        if (pwManagerOpen)        { setPwManagerOpen(false); return; }
        if (passwordModalOpen)    { setPasswordModalOpen(false); return; }
        if (modalOpen && (progress?.files_done === progress?.files_total)) {
          setModalOpen(false); setProgress(null); setExtractError(null); return;
        }
        if (destPickerOpen)       { setDestPickerOpen(false); return; }
        if (entryDestPickerOpen)  { setEntryDestPickerOpen(false); return; }
        if (ctxMenu)              { setCtxMenu(null); return; }
        if (selectedPaths.size)   { setSelectedPaths(new Set()); return; }
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
      entryDestPickerOpen, ctxMenu, selectedPaths, archivePath, tree]);

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
      if (internalDragging.current) return; // ignore events triggered by our own drag-out
      if (e.payload.type === "over") {
        setDragOver(true);
      } else if (e.payload.type === "leave") {
        setDragOver(false);
      } else if (e.payload.type === "drop") {
        setDragOver(false);
        const paths: string[] = (e.payload as { paths?: string[] }).paths ?? [];
        const path = paths[0];
        if (!path) return;
        setMenuOpen(false);
        setDestOptions(null);
        setExpanded(new Set());
        setSelectedPaths(new Set());
        lastAnchorRef.current = null;
        await openArchivePath(path);
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
    return walk(tree);
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
    lastAnchorRef.current = null;
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

  const totalItems = flatCount(tree);

  return (
    <div className="glass">
      {dragOver && <div className="drag-overlay"><span>Drop to open</span></div>}
      <TitleBar />

      {archivePath ? (
        <>
          <div className="actions-row">
            <div className="open-split" ref={openBtnRef}>
              <button className="open-main" onClick={handleOpen}>Open archive…</button>
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
            {loading ? "⏳ Reading archive…" : `📂 ${archivePath} · ${totalItems} items`}
          </p>
          {error && <p className="error">⚠ {error}</p>}

          <div className="entries-wrap">
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
                      archivePath={archivePath}
                      password={password}
                      selectedPaths={selectedPaths}
                      onSelect={(n, multi, shift) => toggleSelect(n, multi, shift)}
                      internalDraggingRef={internalDragging}
                      onContextMenu={(e, n) => {
                        e.preventDefault();
                        // If right-clicking a selected item, act on all selected;
                        // otherwise select just this one.
                        if (selectedPaths.has(n.path)) {
                          ctxNodesRef.current = tree
                            .flatMap(function collect(nd): import("./types").TreeNode[] {
                              return [nd, ...nd.children.flatMap(collect)];
                            })
                            .filter((nd) => selectedPaths.has(nd.path));
                        } else {
                          ctxNodesRef.current = [n];
                          setSelectedPaths(new Set([n.path]));
                        }
                        setCtxMenu({ x: e.clientX, y: e.clientY });
                      }}
                      onDragExtract={(nodes) => {
                        // If dragging a selected item, use all selected nodes
                        if (nodes.length === 0 || (nodes.length === 1 && selectedPaths.has(nodes[0].path) && selectedPaths.size > 1)) {
                          ctxNodesRef.current = collectNodes(tree).filter((n) => selectedPaths.has(n.path));
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
              Open archive…
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
}: {
  progress: import("./types").Progress | null;
  error: string | null;
  dest: string | null;
  onClose: () => void;
}) {
  const done = progress !== null && progress.files_total > 0 && progress.files_done === progress.files_total;
  const pct = progress && progress.files_total > 0
    ? Math.round((progress.files_done / progress.files_total) * 100)
    : 0;
  const inProgress = !done && !error;

  return (
    <div className="modal-backdrop">
      <div className="modal-box">
        <div className="modal-title">
          {error ? "Extraction failed" : done ? "Extraction complete" : "Extracting…"}
        </div>

        {error ? (
          <p className="modal-error">⚠ {error}</p>
        ) : (
          <>
            <div className="modal-bar">
              <div className="modal-fill" style={{ width: `${pct}%`, transition: inProgress ? "width 0.15s ease" : "none" }} />
            </div>
            <div className="modal-status">
              {done
                ? `Done — ${progress!.files_total} files extracted`
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
        className={`entry-row ${node.is_dir ? "entry-dir" : "entry-file"}${isSelected ? " entry-selected" : ""}${dragging ? " entry-dragging" : ""}`}
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
          />
        ))}
    </>
  );
}

export default App;
