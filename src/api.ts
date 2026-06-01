import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { ArchiveEntry, Progress } from "./types";

export function listArchive(path: string): Promise<ArchiveEntry[]> {
  return invoke<ArchiveEntry[]>("list_archive", { path });
}

export function extractArchive(path: string, dest: string): Promise<void> {
  return invoke<void>("extract_archive", { path, dest });
}

export function onExtractProgress(
  cb: (p: Progress) => void
): Promise<UnlistenFn> {
  return listen<Progress>("extract-progress", (e) => cb(e.payload));
}

/** Open a single archive file via the native dialog. Returns null if cancelled. */
export async function pickArchive(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Archives", extensions: ["zip"] }],
  });
  return typeof result === "string" ? result : null;
}

/** Pick a destination directory. Returns null if cancelled. */
export async function pickDestination(): Promise<string | null> {
  const result = await open({ multiple: false, directory: true });
  return typeof result === "string" ? result : null;
}
