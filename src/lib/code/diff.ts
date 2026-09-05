/**
 * Unified-diff parsing for the review panel.
 *
 * Turns `git diff` output into rows the UI can render side-by-side with real line
 * numbers — which is the difference between "a wall of +/- text" and something you can
 * actually review a change in.
 */

export type DiffRowKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** Line number in the OLD file (null for an added line). */
  oldNo: number | null;
  /** Line number in the NEW file (null for a removed line). */
  newNo: number | null;
  /**
   * Position within its file's `rows`. Carried on the row itself so the split view —
   * which reorders rows into left/right pairs — can still look up the row's
   * syntax-highlighted markup, which is keyed by original index.
   *
   * Context lines pulled in by the "expand" buttons are not part of the parsed diff at
   * all, so they carry a NEGATIVE index (`-newNo`) to stay distinguishable from real
   * rows without colliding with them.
   */
  idx: number;
  /**
   * For a `hunk` row only: the ranges its `@@ -a,b +c,d @@` header declares.
   *
   * The review pane needs them to work out how many unchanged lines sit between one
   * hunk and the last, which is exactly what an "expand context" button offers to fill.
   */
  hunkOld?: number;
  hunkOldLen?: number;
  hunkNew?: number;
  hunkNewLen?: number;
}

export interface DiffFile {
  /** Path as the diff header names it (the new path for a rename). */
  path: string;
  /** Old path, when the diff renames. */
  oldPath: string | null;
  rows: DiffRow[];
  added: number;
  removed: number;
  /** git reported the file as binary — there are no rows to show. */
  binary: boolean;
  /**
   * Short human labels for what git said in the header ("new file", "deleted",
   * "renamed", a mode change). Shown as chips beside the filename instead of as rows —
   * `index 0000000..4d6e96f` is noise in a review, and as a row it also forced the
   * gutter open above the first hunk.
   */
  notes: string[];
  /** Whether any row carries an old / new line number (an all-add file has no old). */
  hasOld: boolean;
  hasNew: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip git's `a/` / `b/` prefix from a header path. */
function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "").replace(/^"|"$/g, "");
}

/**
 * Parse `git diff` output (one file or many) into {@link DiffFile}s.
 *
 * Deliberately tolerant: anything that isn't recognised becomes a `meta` row rather than
 * being dropped, so an unusual header (mode change, submodule, `--no-index`) still shows
 * the user what git said instead of an empty panel.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  const start = (path: string, oldPath: string | null) => {
    cur = {
      path,
      oldPath,
      rows: [],
      added: 0,
      removed: 0,
      binary: false,
      notes: [],
      hasOld: false,
      hasNew: false,
    };
    files.push(cur);
    oldNo = 0;
    newNo = 0;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/x b/y` — take the two paths from the end so a path containing
      // " b/" doesn't split the header in the wrong place.
      const rest = line.slice("diff --git ".length);
      const mid = rest.lastIndexOf(" b/");
      const a = mid > 0 ? rest.slice(0, mid) : rest;
      const b = mid > 0 ? rest.slice(mid + 1) : rest;
      const oldPath = stripPrefix(a) === stripPrefix(b) ? null : stripPrefix(a);
      start(stripPrefix(b), oldPath);
      if (oldPath) cur!.notes.push("renamed");
      continue;
    }
    if (!cur) {
      // `--no-index` output for an untracked file starts straight at `--- /dev/null`.
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        start(stripPrefix(line.slice(4).trim()), null);
      } else if (line.trim()) {
        continue;
      } else {
        continue;
      }
    }
    const f = cur!;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("+++ ") && line.slice(4).trim() !== "/dev/null") {
        f.path = stripPrefix(line.slice(4).trim());
      }
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      f.binary = true;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = parseInt(hunk[1], 10);
      newNo = parseInt(hunk[3], 10);
      f.rows.push({
        kind: "hunk",
        text: line,
        oldNo: null,
        newNo: null,
        idx: f.rows.length,
        hunkOld: oldNo,
        hunkOldLen: hunk[2] === undefined ? 1 : parseInt(hunk[2], 10),
        hunkNew: newNo,
        hunkNewLen: hunk[4] === undefined ? 1 : parseInt(hunk[4], 10),
      });
      continue;
    }
    // Header lines become chips on the file header, not rows (see `notes`).
    if (line.startsWith("index ") || line.startsWith("similarity ") || line.startsWith("rename ")) {
      continue;
    }
    if (line.startsWith("new file")) {
      f.notes.push("new file");
      continue;
    }
    if (line.startsWith("deleted file")) {
      f.notes.push("deleted");
      continue;
    }
    if (line.startsWith("old mode") || line.startsWith("new mode")) {
      f.notes.push("mode changed");
      continue;
    }
    if (line.startsWith("+")) {
      f.rows.push({
        kind: "add",
        text: line.slice(1),
        oldNo: null,
        newNo: newNo++,
        idx: f.rows.length,
      });
      f.added++;
      f.hasNew = true;
    } else if (line.startsWith("-")) {
      f.rows.push({
        kind: "del",
        text: line.slice(1),
        oldNo: oldNo++,
        newNo: null,
        idx: f.rows.length,
      });
      f.removed++;
      f.hasOld = true;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      f.rows.push({ kind: "meta", text: line, oldNo: null, newNo: null, idx: f.rows.length });
    } else if (line.startsWith(" ")) {
      f.rows.push({
        kind: "ctx",
        text: line.slice(1),
        oldNo: oldNo++,
        newNo: newNo++,
        idx: f.rows.length,
      });
      f.hasOld = true;
      f.hasNew = true;
    }
    // A bare empty line between files carries no content — skipped.
  }
  return files;
}

/** One line of a side-by-side diff: the old file on the left, the new on the right. */
export interface SideRow {
  left: DiffRow | null;
  right: DiffRow | null;
  /** A hunk/meta row spans the full width instead of splitting. */
  full: DiffRow | null;
}

/**
 * Re-shape unified rows into side-by-side pairs.
 *
 * A run of removals followed by a run of additions is one edit shown twice in a unified
 * diff; side by side, those runs are zipped so the old and new versions of the same line
 * sit opposite each other, and the shorter run is padded with blanks. Context lines pair
 * with themselves.
 */
export function toSideBySide(rows: DiffRow[]): SideRow[] {
  const out: SideRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === "hunk" || row.kind === "meta") {
      out.push({ left: null, right: null, full: row });
      i++;
      continue;
    }
    if (row.kind === "ctx") {
      out.push({ left: row, right: row, full: null });
      i++;
      continue;
    }
    // Collect the removal run, then the addition run that follows it, and zip them.
    const dels: DiffRow[] = [];
    while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      out.push({ left: dels[k] ?? null, right: adds[k] ?? null, full: null });
    }
  }
  return out;
}

/**
 * A short, stable fingerprint of one file's diff.
 *
 * Used to expire a "Viewed" tick: GitHub un-ticks a file when it changes again, and with
 * an agent editing the tree underneath you that is not a nicety — a tick that survived
 * the next rewrite would be actively misleading. FNV-1a, which is plenty for
 * "did these exact lines change".
 */
export function diffSignature(file: DiffFile): string {
  let h = 0x811c9dc5;
  const text = file.rows.map((r) => r.kind + r.text).join("\n");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
