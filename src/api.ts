import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { dirname, basename, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type { TreeNode, Progress } from "./types";

export function openFolder(path: string): Promise<void> {
  return invoke<void>("open_folder", { path });
}

export function extractEntry(
  archivePath: string,
  entryPath: string,
  destDir: string,
  password?: string
): Promise<string> {
  return invoke<string>("extract_entry", {
    archivePath,
    entryPath,
    destDir,
    password: password ?? null,
  });
}

export function extractToTemp(
  archivePath: string,
  entryPath: string,
  password?: string
): Promise<string> {
  return invoke<string>("extract_to_temp", {
    archivePath,
    entryPath,
    password: password ?? null,
  });
}

// 1x1 transparent PNG — the plugin requires an icon but we don't want a custom one.
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Drag a file out of the window using the OS native drag mechanism. */
export async function dragFileOut(filePath: string): Promise<void> {
  await startDrag({ item: [filePath], icon: TRANSPARENT_PNG });
}

export function listArchive(path: string, password?: string): Promise<TreeNode[]> {
  return invoke<TreeNode[]>("list_archive", { path, password: password ?? null });
}

export function extractArchive(path: string, dest: string, password?: string): Promise<void> {
  return invoke<void>("extract_archive", { path, dest, password: password ?? null });
}

export const ERR_PASSWORD_REQUIRED = "this archive is password-protected";
export const ERR_WRONG_PASSWORD = "the password is incorrect";

export function onExtractProgress(
  cb: (p: Progress) => void
): Promise<UnlistenFn> {
  return listen<Progress>("extract-progress", (e) => cb(e.payload));
}

export function compressFiles(
  sources: string[],
  dest: string,
  format: "zip" | "7z",
  level?: number,
  password?: string
): Promise<void> {
  return invoke<void>("compress_files", {
    sources,
    dest,
    format,
    level: level ?? 5,
    password: password ?? null,
  });
}

export function addFilesToArchive(
  archivePath: string, sources: string[], conflictResolution: Record<string, string>,
): Promise<void> {
  return invoke<void>("add_files_to_archive", { archivePath, sources, conflictResolution });
}

export function deleteEntries(
  archivePath: string, entries: string[],
): Promise<void> {
  return invoke<void>("delete_entries", { archivePath, entries });
}

export function onCompressProgress(
  cb: (p: Progress) => void
): Promise<UnlistenFn> {
  return listen<Progress>("compress-progress", (e) => cb(e.payload));
}

/** Pick files/folders for compression. Returns paths or null if cancelled. */
export async function pickFilesForCompress(): Promise<string[] | null> {
  const result = await open({ multiple: true, directory: false });
  if (!result) return null;
  return Array.isArray(result) ? result : [result];
}

/** Pick a single folder. Returns path or null. */
export async function pickFolder(): Promise<string | null> {
  const result = await open({ multiple: false, directory: true });
  return typeof result === "string" ? result : null;
}

/** Open a single archive file via the native dialog. Returns null if cancelled. */
export async function pickArchive(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "Archives",
        extensions: ["zip", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "rar"],
      },
    ],
  });
  return typeof result === "string" ? result : null;
}

/** Pick a destination directory. Returns null if cancelled. */
export async function pickDestination(): Promise<string | null> {
  const result = await open({ multiple: false, directory: true });
  return typeof result === "string" ? result : null;
}

/** Pre-computed extract destinations for an opened archive. */
export interface DestOptions {
  /** The directory that contains the archive (the "Extract here" target). */
  here: string;
  /** A sibling folder named after the archive minus its last extension. */
  sameName: string;
  /** The folder name shown in the UI (archive filename minus last extension). */
  stem: string;
}

/** Compute the same-name / same-dir destinations for an archive path. */
export async function computeDestOptions(archivePath: string): Promise<DestOptions> {
  const dir = await dirname(archivePath);
  const base = await basename(archivePath);
  const stem = base.replace(/\.[^.]+$/, "");
  const sameName = await join(dir, stem);
  return { here: dir, sameName, stem };
}

export { revealItemInDir };

/** Read text content of a file, up to 512KB. */
export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** Read any file as base64 data URL, up to 2MB. */
export function readFileBase64(path: string): Promise<string> {
  return invoke<string>("read_file_base64", { path });
}
