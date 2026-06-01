export interface ArchiveEntry {
  path: string;
  size: number;
  is_dir: boolean;
}

export interface Progress {
  current_file: string;
  files_done: number;
  files_total: number;
}
