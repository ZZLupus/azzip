import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { dirname, basename, join } from "@tauri-apps/api/path";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { TreeNode, Progress } from "./types";

export function listArchive(path: string): Promise<TreeNode[]> {
  return invoke<TreeNode[]>("list_archive", { path });
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
    filters: [
      {
        name: "Archives",
        extensions: ["zip", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz"],
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

export { openPath, revealItemInDir };
