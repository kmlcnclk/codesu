import { invoke } from "@tauri-apps/api/core";

/** One entry of a directory listing (mirrors `fsx::DirEntry`). */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** A dotfile — hidden behind the tree's "show hidden" toggle. */
  hidden: boolean;
  /** A build/dependency directory (node_modules, target, …) — never auto-expanded. */
  heavy: boolean;
  size: number;
}

/** A file read for the editor (mirrors `fsx::FileContent`). */
export interface FileContent {
  path: string;
  content: string;
  /** "too-large" | "binary" when the file cannot be edited here; `content` is empty. */
  refused: string | null;
  size: number;
  modifiedMs: number;
}

/** One changed path from `git status` (mirrors `git::FileChange`). */
export interface FileChange {
  path: string;
  absPath: string;
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
  origPath: string | null;
}

export interface RepoStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  changes: FileChange[];
}

/** A runnable command discovered in the workspace (mirrors `runner::Script`). */
export interface Script {
  id: string;
  name: string;
  command: string;
  source: string;
  cwd: string;
  file: string;
}

/**
 * Rust serializes struct fields in snake_case; the UI reads camelCase. Converting at
 * this boundary (rather than sprinkling `is_dir` through the components) keeps every
 * consumer in one naming convention.
 */
function camel<T>(v: any): T {
  if (Array.isArray(v)) return v.map(camel) as T;
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = camel(val);
    }
    return out as T;
  }
  return v as T;
}

export const listDir = async (root: string, path: string): Promise<DirEntry[]> =>
  camel(await invoke("list_dir", { root, path }));

export const readTextFile = async (root: string, path: string): Promise<FileContent> =>
  camel(await invoke("read_text_file", { root, path }));

/**
 * Save `content` to `path`. `expectModifiedMs` is the mtime the buffer was loaded at —
 * the write is rejected with "changed-on-disk" if the file moved on since (an agent or
 * git touched it). Returns the new mtime.
 */
export const writeTextFile = (
  root: string,
  path: string,
  content: string,
  expectModifiedMs: number | null,
): Promise<number> =>
  invoke("write_text_file", { root, path, content, expectModifiedMs });

export const gitStatus = async (repo: string): Promise<RepoStatus> =>
  camel(await invoke("git_status", { repo }));

export const gitDiffFile = (
  repo: string,
  path: string,
  staged: boolean,
  untracked: boolean,
): Promise<string> => invoke("git_diff_file", { repo, path, staged, untracked });

export const gitDiffAll = (repo: string, staged: boolean): Promise<string> =>
  invoke("git_diff_all", { repo, staged });

export const gitStageFile = (repo: string, path: string, staged: boolean): Promise<void> =>
  invoke("git_stage_file", { repo, path, staged });

export const discoverScripts = async (root: string): Promise<Script[]> =>
  camel(await invoke("discover_scripts", { root }));

export const isGitRepo = (path: string): Promise<boolean> =>
  invoke("is_git_repo", { path });

// ---------- display helpers ----------

/** Last path segment. */
export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** `path` written relative to `root` (unchanged when it isn't underneath). */
export function relPath(root: string, path: string): string {
  const r = root.endsWith("/") ? root : root + "/";
  return path.startsWith(r) ? path.slice(r.length) : path;
}

/** The one-letter code git shows for a change, and the colour to show it in. */
export function changeBadge(c: FileChange): { code: string; label: string; color: string } {
  if (c.untracked) return { code: "U", label: "Untracked", color: "var(--ok)" };
  const code = (c.index !== " " && c.index !== "?" ? c.index : c.worktree).toUpperCase();
  switch (code) {
    case "A":
      return { code: "A", label: "Added", color: "var(--ok)" };
    case "D":
      return { code: "D", label: "Deleted", color: "var(--danger)" };
    case "R":
      return { code: "R", label: "Renamed", color: "var(--accent-bright)" };
    case "C":
      return { code: "C", label: "Copied", color: "var(--accent-bright)" };
    default:
      return { code: "M", label: "Modified", color: "var(--warn)" };
  }
}

/** Human-readable byte size for the tree and the "too large" notice. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
