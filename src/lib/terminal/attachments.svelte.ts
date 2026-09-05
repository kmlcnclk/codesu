/**
 * Getting files INTO an agent's prompt, and keeping a visible record of what went in.
 *
 * An agent reads attachments off disk, so every route ends the same way: an absolute
 * path typed at the prompt. Dropped and picked files already have one; a pasted image
 * does not, so its bytes are written to a temp file first (`save_pasted_file`).
 *
 * Everything a pane attached this session is also kept here, which is what the pane's
 * attachment tray renders — the terminal itself only ever shows the path text, so
 * without this you cannot see what you actually sent.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { makeAttachment, type TaskAttachment } from "$lib/store/app.svelte";
import type { TerminalHandle } from "./createTerminal";

/** Live terminals, so a drop can reach the pane the pointer was actually over. */
const panes = new Map<string, TerminalHandle>();

/** What each pane has attached this session, newest last. Rendered by its tray. */
const byPane = $state<Record<string, TaskAttachment[]>>({});

/** When each (pane, path) was last sent, for collapsing one gesture reported twice. */
const recent = new Map<string, number>();

/**
 * How long two identical (pane, path) attachments count as one gesture. Long enough
 * to swallow a single event reported twice, short enough that a person re-dropping a
 * file because they think it failed is not silently ignored — which is its own bug.
 */
const DUPLICATE_MS = 600;

/**
 * Files dropped on a pane whose terminal is not running yet. There is nothing to type
 * them into, and dropping them on the floor is what made attaching look flaky, so
 * they wait here and are sent when the terminal appears.
 *
 * Note this never STARTS an agent: a dormant Claude session is only ever resumed by
 * an explicit click.
 */
const pending = new Map<string, string[]>();

/** Per-pane message for its tray ("waiting for the agent", or why nothing happened). */
export const notices = $state<Record<string, string | null>>({});

/** The pane a drag is currently over, and how many files it carries. */
export const dragState = $state<{ agentId: string | null; count: number }>({
  agentId: null,
  count: 0,
});

/** Thumbnail-able files the asset protocol has been granted, by path. */
const allowed = $state<Set<string>>(new Set());

export function attachmentsOf(agentId: string): TaskAttachment[] {
  return byPane[agentId] ?? [];
}

/** True once the asset protocol will serve this image to the webview. */
export function isThumbnailable(path: string): boolean {
  return allowed.has(path);
}

export function thumbnailSrc(path: string): string {
  return convertFileSrc(path);
}

/** Called by a pane once its terminal exists; and again with null on teardown. */
export function registerPane(agentId: string, handle: TerminalHandle | null) {
  if (!handle) {
    panes.delete(agentId);
    return;
  }
  panes.set(agentId, handle);

  const waiting = pending.get(agentId);
  if (!waiting?.length) return;
  pending.delete(agentId);
  // The PTY is live, but the agent inside it is still printing its banner — text sent
  // now would land in the middle of that. A beat later the prompt is listening.
  setTimeout(() => {
    notices[agentId] = null;
    attach(agentId, waiting);
  }, 1500);
}

/**
 * Quote a path for the prompt only when it needs it. An agent accepts a bare path,
 * and quoting everything would put stray quotes into prompts that are mostly prose.
 */
export function quotePath(path: string): string {
  return /[\s"']/.test(path) ? `"${path.replace(/(["\\])/g, "\\$1")}"` : path;
}

/**
 * Attach files to a pane: type their paths at its prompt and record them for the
 * tray. Paths already attached are skipped, so a re-drop of the same file cannot
 * double it up.
 *
 * Returns the paths it actually inserted.
 */
export function attach(agentId: string, paths: string[]): string[] {
  const clean = paths.filter(Boolean);
  if (clean.length === 0) return [];

  const handle = panes.get(agentId);
  if (!handle) {
    // Dormant pane: hold the files and say so, rather than accepting the drop and
    // doing nothing — the silent version is what made this look intermittent.
    const queue = pending.get(agentId) ?? [];
    for (const p of clean) if (!queue.includes(p)) queue.push(p);
    pending.set(agentId, queue);
    notices[agentId] = `${queue.length} file${queue.length === 1 ? "" : "s"} waiting — press Resume to start this agent`;
    return [];
  }

  // Same file, same pane, moments apart = one gesture reported twice. A permanent
  // "already attached" skip would be wrong: re-sending a file you edited since is a
  // real thing to want.
  const now = Date.now();
  const fresh = clean.filter((p) => {
    const key = `${agentId}\u0000${p}`;
    const last = recent.get(key) ?? 0;
    if (now - last < DUPLICATE_MS) return false;
    recent.set(key, now);
    return true;
  });
  if (fresh.length === 0) return [];

  const list = byPane[agentId] ?? (byPane[agentId] = []);
  const have = new Set(list.map((a) => a.path));
  for (const path of fresh) {
    // One chip per file, however many times its path is sent.
    if (!have.has(path)) {
      const item = makeAttachment(path);
      list.push(item);
      if (item.isImage) void grantThumbnail(path);
    }
  }
  handle.paste(fresh.map(quotePath).join(" ") + " ");
  return fresh;
}

/** Re-type one recorded attachment's path (the tray's click action). */
export function insertAgain(agentId: string, path: string) {
  panes.get(agentId)?.paste(quotePath(path) + " ");
}

export function forget(agentId: string, id: string) {
  const list = byPane[agentId];
  if (!list) return;
  byPane[agentId] = list.filter((a) => a.id !== id);
}

export function forgetAll(agentId: string) {
  byPane[agentId] = [];
}

/**
 * The asset-protocol scope starts empty; each image is granted individually so the
 * webview can thumbnail exactly the files the user attached and nothing else — the
 * same rule the task dialog follows.
 */
async function grantThumbnail(path: string) {
  if (allowed.has(path)) return;
  try {
    await invoke("allow_asset", { path });
    allowed.add(path);
  } catch (err) {
    // Not fatal: the tray falls back to a file glyph.
    console.warn("[Codesu] no thumbnail for", path, err);
  }
}

/** Pick files with the native dialog and attach them. */
export async function pickFiles(agentId: string): Promise<string[]> {
  const picked = await open({ multiple: true, title: "Attach files to this agent" });
  if (!picked) return [];
  const paths = (Array.isArray(picked) ? picked : [picked]).filter(
    (p): p is string => typeof p === "string",
  );
  return attach(agentId, paths);
}

/**
 * Save a pasted image to a temp file and attach it.
 *
 * Base64 rather than a byte array: a JSON array of numbers roughly triples a
 * screenshot on the way across the IPC bridge.
 */
export async function attachBlob(agentId: string, file: File | Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // Chunked so a multi-megabyte image cannot blow String.fromCharCode's argument
  // limit with a single spread.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  const ext = (file.type || "image/png").split("/")[1] ?? "png";
  const path = await invoke<string>("save_pasted_file", { dataB64: btoa(binary), ext });
  attach(agentId, [path]);
  return path;
}

/** The agent whose pane sits under a CSS-pixel point, if any. */
function paneAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest<HTMLElement>("[data-agent-id]")?.dataset.agentId ?? null;
}

/**
 * Which pane a drag is over.
 *
 * Tauri reports the position in PHYSICAL pixels, so it normally needs dividing by the
 * device pixel ratio — but that assumption is exactly what made dropping unreliable:
 * get the scale wrong (an external monitor, a scaled display, a ratio that is not the
 * window's) and the point lands somewhere else entirely, hits no pane, and the drop
 * quietly does nothing.
 *
 * So try the scaled point, then the raw one, and finally fall back to whichever pane
 * the drag was last seen over. Any answer beats silently dropping the file.
 */
function targetOf(position: { x: number; y: number }): string | null {
  const dpr = window.devicePixelRatio || 1;
  return (
    paneAt(position.x / dpr, position.y / dpr) ??
    paneAt(position.x, position.y) ??
    dragState.agentId
  );
}

/**
 * Installed once per WEBVIEW, and it must stay that way: a second listener attaches
 * every dropped file twice.
 *
 * The flag lives on `window`, not in module scope, because HMR replaces the module —
 * a module-level guard is reset by the very reload it needs to survive, and the old
 * listener is still attached.
 */
declare global {
  interface Window {
    __codesuFileDrop?: Promise<() => void>;
  }
}

/**
 * Window-level file drop. Tauri owns the drag events (`dragDropEnabled` in
 * tauri.conf.json), which is what makes real filesystem paths available — a webview
 * `drop` hands over File objects with no path, so a dropped file would have to be
 * COPIED to be usable. It then routes the paths to the pane under the pointer.
 */
export function installFileDrop(): Promise<() => void> {
  if (window.__codesuFileDrop) return window.__codesuFileDrop;

  /**
   * Watchdog. `over` fires continuously while a drag is inside the window, so a gap
   * means the drag is gone — and a `leave` that never arrives (the drag ended outside
   * the window, or the webview reloaded mid-drag) would otherwise leave every pane
   * wearing its drop overlay forever.
   */
  let idle: ReturnType<typeof setTimeout> | undefined;
  const clearDrag = () => {
    clearTimeout(idle);
    idle = undefined;
    dragState.agentId = null;
    dragState.count = 0;
  };
  // The overlay is driven by dragState.agentId, so clearing it on `drop` must happen
  // AFTER the target has been read — see the drop branch below.

  // A real Tauri drag produces no mouse events, so any pointer movement is proof
  // that no drag is in flight.
  window.addEventListener("mousemove", () => {
    if (dragState.agentId !== null) clearDrag();
  });
  window.addEventListener("blur", clearDrag);

  /*
   * Belt and braces: cancel the WEBVIEW's own drag handling too.
   *
   * With Tauri's drag events enabled the DOM should not see these at all, so this is
   * insurance rather than a fix — if it ever does, xterm's hidden textarea would
   * accept the dropped file and WebKit would insert its URL as text, handing the
   * agent a second copy behind our back.
   */
  const blockNativeDrag = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
    window.addEventListener(type, blockNativeDrag, true);
    document.addEventListener(type, blockNativeDrag, true);
  }

  const listening = getCurrentWebview().onDragDropEvent(({ payload }) => {
    /*
     * Tauri emits FOUR types: enter, over, drop, leave — and `enter` carries `paths`
     * just like `drop` does. Switch on the type explicitly and attach on `drop`
     * ALONE: an else-branch "everything that isn't over/leave is a drop" attached the
     * file the moment the drag entered the window, and again when it landed. That was
     * the duplicate — one on drag, one on drop.
     */
    switch (payload.type) {
      case "enter":
      case "over": {
        // `dragState.agentId` is also the drop's last-resort target, so only overwrite
        // it when the pointer is genuinely over a pane.
        const over = targetOf(payload.position);
        if (over) dragState.agentId = over;
        if (payload.type === "enter") dragState.count = payload.paths?.length ?? 0;
        clearTimeout(idle);
        idle = setTimeout(clearDrag, 600);
        return;
      }
      case "drop": {
        const agentId = targetOf(payload.position);
        const paths = payload.paths ?? [];
        clearDrag();
        if (agentId && paths.length) attach(agentId, paths);
        return;
      }
      case "leave":
        clearDrag();
        return;
    }
  });

  window.__codesuFileDrop = listening;
  return listening;
}
