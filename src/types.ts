export interface ArchiveEntry {
  path: string;
  size: number;
  is_dir: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  children: TreeNode[];
}

export interface Progress {
  current_file: string;
  files_done: number;
  files_total: number;
  bytes_done?: number;
  bytes_total?: number;
}
