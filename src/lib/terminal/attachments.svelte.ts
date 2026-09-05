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
import { app, makeAttachment, type TaskAttachment } from "$lib/store/app.svelte";
import type { TerminalHandle } from "./createTerminal";

/* ------------------------------------------------------------------ *
 * TEMPORARY DIAGNOSTIC — remove once drag & drop is confirmed working.
 *
 * The webview's console is not reachable from a `tauri dev` terminal, so every step
 * of a drag is appended to `.dnd-diag.log` in the project root instead.
 * ------------------------------------------------------------------ */
const DIAG_ROOT = "/Users/kmlcnclk/Projects/Github/codesu";
// On `window`, not in module scope: a hot reload builds a new module and a
// module-level buffer would start empty and overwrite the file, erasing exactly the
// drag events we are trying to read.
const diagLines: string[] = ((window as unknown as { __codesuDiag?: string[] }).__codesuDiag ??= []);
let diagLastOver = 0;
export function trace(line: string) {
  try {
    diagLines.push(`${new Date().toISOString().slice(11, 23)}  ${line}`);
    if (diagLines.length > 400) diagLines.splice(0, diagLines.length - 400);
    void invoke("write_text_file", {
      root: DIAG_ROOT,
      path: `${DIAG_ROOT}/.dnd-diag.log`,
      content: diagLines.join("\n") + "\n",
    }).catch(() => {});
  } catch {
    /* diagnostics must never break the thing they are diagnosing */
  }
}
trace(`module loaded — guard=${typeof window !== "undefined" && !!window.__codesuFileDrop}`);

/** Live terminals, so a drop can reach the pane the pointer was actually over. */
const panes = new Map<string, TerminalHandle>();

/** What each pane has attached this session, newest last. Rendered by its tray. */
/*
 * Reassigned rather than mutated in place.
 *
 * A pane's tray reads `byPane[id]` before that key exists, and growing an existing
 * array (or adding a brand-new key) is the case where a reader that saw `undefined`
 * can miss the update — which showed up as a file being typed at the prompt while the
 * tray still said "Nothing yet". Replacing the whole record makes the change
 * unmissable, and these lists are a handful of entries.
 */
let byPane = $state<Record<string, TaskAttachment[]>>({});

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

/**
 * Text waiting for a pane that is not running yet (review comments sent to a dormant
 * agent). Held for the same reason as `pending`, and flushed by the same hook.
 */
const pendingText = new Map<string, string[]>();

/** Per-pane message for its tray ("waiting for the agent", or why nothing happened). */
export const notices = $state<Record<string, string | null>>({});

/**
 * Live drag state, for the overlay that paints while files are over the window.
 *
 * Painting nothing during a drag is what made this feature look broken rather than
 * merely misaimed: a drop that missed and a drop that never arrived are the same
 * empty screen. `agentId` is the pane the files would land on right now, so the
 * answer to "where is this going" is on screen BEFORE the mouse button comes up.
 */
export const drag = $state<{ over: boolean; agentId: string | null }>({
  over: false,
  agentId: null,
});

/**
 * What the last drop actually did. Rendered as a brief toast, deliberately NOT inside
 * the attachment tray — the tray is closed by default, so a message posted there is
 * invisible to the person who just dropped a file and is waiting for a sign.
 */
export const landing = $state<{ text: string | null; tone: "ok" | "wait" | "warn"; at: number }>({
  text: null,
  tone: "ok",
  at: 0,
});

/** Post a drop result to the toast; it clears itself. */
function report(text: string, tone: "ok" | "wait" | "warn") {
  landing.text = text;
  landing.tone = tone;
  landing.at = Date.now();
  const stamp = landing.at;
  setTimeout(() => {
    // Only clear our own message — a later drop owns the toast now.
    if (landing.at === stamp) landing.text = null;
  }, 4000);
}

/**
 * When Tauri last reported a real DROP (not merely a drag passing overhead).
 *
 * The DOM fallback defers to it for this long, and no longer: an `enter` that is
 * never followed by a `drop` must NOT disarm the fallback, or a half-working native
 * route swallows every file in silence.
 */
let nativeDropAt = 0;
const NATIVE_DROP_WINS_MS = 1200;

/**
 * The pane a drag was last seen over. Not reactive and not exported: nothing renders
 * it any more (a drag paints nothing over the pane) — it exists only so a drop whose
 * coordinates cannot be resolved still knows where the file was headed.
 */
let lastDragTarget: string | null = null;

/**
 * Thumbnail-able files the asset protocol has been granted, by path. Reassigned for
 * the same reason as `byPane`: a chip renders before the grant comes back, and must
 * re-render when it does.
 */
let allowed = $state<string[]>([]);

export function attachmentsOf(agentId: string): TaskAttachment[] {
  return byPane[agentId] ?? [];
}

/** True once the asset protocol will serve this image to the webview. */
export function isThumbnailable(path: string): boolean {
  return allowed.includes(path);
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
  const text = pendingText.get(agentId);
  if (!waiting?.length && !text?.length) return;
  pending.delete(agentId);
  pendingText.delete(agentId);
  // The PTY is live, but the agent inside it is still printing its banner — text sent
  // now would land in the middle of that. A beat later the prompt is listening.
  setTimeout(() => {
    notices[agentId] = null;
    if (waiting?.length) attach(agentId, waiting);
    for (const t of text ?? []) {
      handle.paste(t);
      handle.focus();
    }
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

  const list = byPane[agentId] ?? [];
  const have = new Set(list.map((a) => a.path));
  const added: TaskAttachment[] = [];
  for (const path of fresh) {
    // One chip per file, however many times its path is sent.
    if (have.has(path)) continue;
    have.add(path);
    const item = makeAttachment(path);
    added.push(item);
    if (item.isImage) void grantThumbnail(path);
  }
  if (added.length > 0) byPane = { ...byPane, [agentId]: [...list, ...added] };
  const text = fresh.map(quotePath).join(" ") + " ";
  trace(`attach -> paste ${JSON.stringify(text)}`);
  handle.paste(text);
  // TEMP DIAGNOSTIC — read the terminal's own screen back, which is the only way to
  // tell "we wrote it to the PTY" apart from "the agent actually took it".
  setTimeout(() => {
    try {
      trace(`screen 500ms after paste:\n${handle.screen(6)}`);
    } catch (err) {
      trace(`screen read failed: ${String(err)}`);
    }
  }, 500);
  return fresh;
}

/**
 * Type arbitrary text at an agent's prompt, without submitting it.
 *
 * Used by the review page to hand a batch of comments to Claude: the text lands in the
 * prompt exactly as a paste would, and the user presses Enter (or edits it first, or
 * throws it away).
 *
 * A dormant pane does not lose the text — it is held and typed as soon as that agent's
 * terminal comes up. Starting the agent is the caller's move (sending is an explicit
 * gesture); this only makes sure nothing is dropped in between. Returns "live" when the
 * text went straight to a running prompt and "queued" when it is waiting for one.
 */
export function insertAtPrompt(agentId: string, text: string): "live" | "queued" {
  if (!text) return "live";
  const handle = panes.get(agentId);
  if (handle) {
    handle.paste(text);
    handle.focus();
    return "live";
  }
  const queue = pendingText.get(agentId) ?? [];
  queue.push(text);
  pendingText.set(agentId, queue);
  return "queued";
}

/** Re-type one recorded attachment's path (the tray's click action). */
export function insertAgain(agentId: string, path: string) {
  panes.get(agentId)?.paste(quotePath(path) + " ");
}

export function forget(agentId: string, id: string) {
  const list = byPane[agentId];
  if (!list) return;
  byPane = { ...byPane, [agentId]: list.filter((a) => a.id !== id) };
}

export function forgetAll(agentId: string) {
  byPane = { ...byPane, [agentId]: [] };
}

/**
 * The asset-protocol scope starts empty; each image is granted individually so the
 * webview can thumbnail exactly the files the user attached and nothing else — the
 * same rule the task dialog follows.
 */
async function grantThumbnail(path: string) {
  if (allowed.includes(path)) return;
  try {
    await invoke("allow_asset", { path });
    allowed = [...allowed, path];
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
  const path = await copyToTemp(file);
  attach(agentId, [path]);
  return path;
}

/**
 * Write a blob's bytes to a temp file and return its path. The shared half of
 * "something arrived as bytes, and an agent can only read paths" — a pasted
 * screenshot and a DOM-dropped file are the same problem.
 */
async function copyToTemp(file: File | Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // Chunked so a multi-megabyte image cannot blow String.fromCharCode's argument
  // limit with a single spread.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  // Prefer the real filename's extension — a dropped `.ts` is not an image, and the
  // MIME type for one is frequently blank or wrong.
  const named = file instanceof File ? /\.([A-Za-z0-9]{1,8})$/.exec(file.name)?.[1] : undefined;
  const ext = named ?? (file.type || "image/png").split("/")[1] ?? "png";
  return invoke<string>("save_pasted_file", { dataB64: btoa(binary), ext });
}

/**
 * Last-resort attach for a DOM drop: the browser hands over File objects with no
 * path, so the only way to give the agent something it can open is to write the bytes
 * out and attach THAT. A copy, and named as one — an edit the agent makes lands in a
 * temp file rather than the user's original, and the path in the prompt says so.
 */
async function attachDroppedCopies(agentId: string, files: File[]) {
  const saved: string[] = [];
  let why = "";
  for (const file of files) {
    try {
      saved.push(await copyToTemp(file));
    } catch (err) {
      // Keep the reason — the common one is the 20MB copy limit, and "could not read
      // the file" would send someone hunting for a permissions problem they do not have.
      why = String(err instanceof Error ? err.message : err);
      trace(`copy failed for ${file.name}: ${why}`);
      console.error("[Codesu] could not copy dropped file", file.name, err);
    }
  }
  if (!saved.length) {
    report(why || "Could not read the dropped file", "warn");
    return;
  }
  const name = app.agents.find((a) => a.id === agentId)?.name ?? "agent";
  const sent = attach(agentId, saved);
  const count = `${saved.length} file${saved.length === 1 ? "" : "s"}`;
  if (sent.length > 0) report(`${count} copied → ${name}`, "ok");
  else report(`${count} waiting for ${name} — press Resume`, "wait");
}

/** The agent whose pane sits under a CSS-pixel point, if any. */
function paneAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest<HTMLElement>("[data-agent-id]")?.dataset.agentId ?? null;
}

/**
 * The pane genuinely under a drag, or null.
 *
 * Tauri TYPES this position as physical pixels, and on Windows and Linux it is — but
 * on macOS it is not. wry builds it from `draggingLocation()` against the web view's
 * `frame()`, and an NSView frame is measured in POINTS, so what arrives here is
 * already CSS pixels. Dividing by the device pixel ratio on a Retina display
 * therefore halves a point that was never scaled, and the drop lands in the top-left
 * quadrant of the window — usually on a different pane, or on no pane at all.
 *
 * So: the raw point first (correct on macOS), the scaled one only as a fallback for
 * the platforms that really do report physical pixels.
 *
 * No further guessing here on purpose: this is the honest answer to "where is the
 * pointer", which is what `lastDragTarget` must record. Guessing belongs to the drop.
 */
function paneUnder(position: { x: number; y: number }): string | null {
  const dpr = window.devicePixelRatio || 1;
  return paneAt(position.x, position.y) ?? (dpr === 1 ? null : paneAt(position.x / dpr, position.y / dpr));
}

/**
 * Where a DROP should go. Generous by design — the failure mode being fixed is a file
 * that silently goes nowhere — so an unresolvable position falls back to wherever the
 * drag was last seen, and finally to the agent you are looking at.
 */
function dropTargetOf(position: { x: number; y: number }): string | null {
  return paneUnder(position) ?? lastDragTarget ?? app.activeAgent?.id ?? null;
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
    __codesuFileDropTeardown?: () => void;
  }
}

/*
 * HMR: hand the listeners over instead of leaving the old ones in charge.
 *
 * The window-level guard is what stops a second listener attaching every file twice,
 * and it deliberately outlives the module. But that cuts both ways — after a hot
 * reload the REPLACED module's listeners are still the live ones, and the new code
 * installs nothing, so an edit to this file appears to do nothing at all until the
 * app is fully restarted. Disposing here clears the guard as the old module goes, and
 * the reloaded one installs itself normally.
 */
/*
 * Retire the previous install as this module comes up.
 *
 * `import.meta.hot.dispose` alone was not enough: it only runs when this module is
 * the accepted HMR boundary, and when it is not, the replaced module's listeners stay
 * in charge while the new code installs nothing — an edit to this file then appears
 * to do nothing at all. Doing it here instead runs on EVERY evaluation of the module,
 * which is the one moment we know a newer version is taking over. A fresh page load
 * has no teardown registered, so this is a no-op there.
 */
if (typeof window !== "undefined" && window.__codesuFileDropTeardown) {
  trace("handing over from a previous install");
  try {
    window.__codesuFileDropTeardown();
  } catch (err) {
    trace(`teardown failed: ${String(err)}`);
  }
  window.__codesuFileDropTeardown = undefined;
  window.__codesuFileDrop = undefined;
}

/**
 * Window-level file drop. Tauri owns the drag events (`dragDropEnabled` in
 * tauri.conf.json), which is what makes real filesystem paths available — a webview
 * `drop` hands over File objects with no path, so a dropped file would have to be
 * COPIED to be usable. It then routes the paths to the pane under the pointer.
 */
export function installFileDrop(): Promise<() => void> {
  trace(`installFileDrop() called — already installed=${!!window.__codesuFileDrop}`);
  if (window.__codesuFileDrop) return window.__codesuFileDrop;

  /** Everything this install attached, so a hot reload can hand over cleanly. */
  const undo: (() => void)[] = [];
  const on = <K extends keyof WindowEventMap>(
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    capture = false,
  ) => {
    for (const target of [window, document] as EventTarget[]) {
      target.addEventListener(type, fn as EventListener, capture);
      undo.push(() => target.removeEventListener(type, fn as EventListener, capture));
    }
  };

  const clearDragPaint = () => {
    drag.over = false;
    drag.agentId = null;
  };

  // A real Tauri drag produces no mouse events, so any pointer movement means the
  // drag is over and the remembered target is stale.
  on("mousemove", () => {
    lastDragTarget = null;
    clearDragPaint();
  });
  on("blur", () => {
    lastDragTarget = null;
    clearDragPaint();
  });

  /*
   * Take the WEBVIEW's own drag handling away from the page.
   *
   * Letting these through is not an option: xterm's hidden textarea would accept the
   * drop and WebKit would insert the file's URL as text, handing the agent a second
   * copy behind our back. But swallowing them and doing nothing is how a drop becomes
   * a black hole — which is the whole complaint. So they are swallowed AND answered.
   */
  const blockNativeDrag = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  on("dragenter", blockNativeDrag, true);
  on("dragleave", blockNativeDrag, true);

  /*
   * `dragover` repeats every few hundred ms for as long as the pointer is inside the
   * window, so its absence is how we learn the drag left. `dragleave` cannot tell us:
   * it also fires on every hop between elements, and clearing on those would flicker
   * the overlay off and on across the whole window.
   */
  let domDragIdle: ReturnType<typeof setTimeout> | undefined;
  on(
    "dragover",
    (e: DragEvent) => {
      // Cancelling every dragover is the DOM rule for "this is a drop target".
      // Without it WebKit shows the no-entry cursor and never fires `drop`.
      blockNativeDrag(e);
      if (Date.now() - diagLastOver > 500) {
        diagLastOver = Date.now();
        trace(`DOM dragover @${e.clientX},${e.clientY} kinds=${Array.from(e.dataTransfer?.items ?? []).map((i) => i.kind).join("|")}`);
      }
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      const over = paneAt(e.clientX, e.clientY);
      if (over) lastDragTarget = over;
      drag.over = true;
      drag.agentId = over ?? lastDragTarget ?? app.activeAgent?.id ?? null;
      clearTimeout(domDragIdle);
      domDragIdle = setTimeout(clearDragPaint, 400);
    },
    true,
  );

  on(
    "drop",
    (e: DragEvent) => {
      blockNativeDrag(e);
      trace(`DOM drop @${e.clientX},${e.clientY} files=${e.dataTransfer?.files.length ?? 0} sinceNativeDrop=${Date.now() - nativeDropAt}ms`);
      clearTimeout(domDragIdle);
      clearDragPaint();

      /*
       * Armed PER DRAG, not per session.
       *
       * The native route is authoritative whenever it delivers: it yields the file's
       * REAL path, where this one can only produce a copy. But "Tauri sent us an
       * `enter` once" is not evidence that its `drop` will arrive — and gating on
       * that is precisely how a half-working native route swallows every file in
       * silence. So the only thing that disarms this is a native DROP that actually
       * landed, moments ago, for this same gesture.
       */
      if (Date.now() - nativeDropAt < NATIVE_DROP_WINS_MS) return;

      // `dataTransfer` is only readable during the event, and the pointer position is
      // only meaningful now — so both are taken synchronously, whatever we decide to
      // do with them. The File objects stay readable after the handler returns.
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      const agentId = paneAt(e.clientX, e.clientY) ?? lastDragTarget ?? app.activeAgent?.id ?? null;
      lastDragTarget = null;
      if (!agentId) {
        report("Nothing to attach to — open an agent first", "warn");
        return;
      }

      /*
       * Give the native drop the last word before falling back.
       *
       * The two routes are meant to be mutually exclusive, but the native one travels
       * through the event loop and IPC, so if both ever fire this one gets there
       * first — and attaching immediately would give the agent the file twice, once
       * as a real path and once as a copy. A beat of patience costs nothing here and
       * makes the duplicate impossible.
       */
      const at = Date.now();
      setTimeout(() => {
        if (nativeDropAt >= at) return; // the real path landed; nothing to fall back to
        void attachDroppedCopies(agentId, files);
      }, 250);
    },
    true,
  );

  const listening = getCurrentWebview().onDragDropEvent(({ payload }) => {
    trace(`NATIVE ${payload.type} ${JSON.stringify((payload as { position?: unknown }).position ?? null)} paths=${JSON.stringify((payload as { paths?: string[] }).paths ?? null)} dpr=${window.devicePixelRatio}`);
    /*
     * Tauri emits FOUR types: enter, over, drop, leave — and `enter` carries `paths`
     * exactly like `drop` does. Hence the explicit switch: an else-branch treating
     * "anything that isn't over/leave" as a drop attached the file when the drag
     * arrived AND again when it landed. Files are attached on `drop` and nowhere else.
     */
    switch (payload.type) {
      // enter / over attach nothing. They only record where the pointer really is, so
      // a drop whose coordinates cannot be resolved still knows where it was headed.
      case "enter":
      case "over": {
        const over = paneUnder(payload.position);
        if (over) lastDragTarget = over;
        // Paint the drag even when it is over no pane: "you are dragging onto Codesu,
        // but not onto an agent" is the single most useful thing to say here, and it
        // is exactly what an unpainted window failed to say.
        drag.over = true;
        drag.agentId = over ?? lastDragTarget ?? app.activeAgent?.id ?? null;
        return;
      }

      // The one place a dropped PATH is attached.
      case "drop": {
        nativeDropAt = Date.now();
        const agentId = dropTargetOf(payload.position);
        const paths = payload.paths ?? [];
        lastDragTarget = null;
        clearDragPaint();

        if (!paths.length) return;
        if (!agentId) {
          report("Nothing to attach to — open an agent first", "warn");
          return;
        }

        const name = app.agents.find((a) => a.id === agentId)?.name ?? "agent";
        trace(`NATIVE drop -> agent=${agentId} (${name}) live=${panes.has(agentId)}`);
        const sent = attach(agentId, paths);
        const count = `${paths.length} file${paths.length === 1 ? "" : "s"}`;
        if (sent.length > 0) report(`${count} → ${name}`, "ok");
        else if (pending.get(agentId)?.length) report(`${count} waiting for ${name} — press Resume`, "wait");
        else report(`${count} already attached to ${name}`, "ok");
        return;
      }

      case "leave":
        lastDragTarget = null;
        clearDragPaint();
        return;
    }
  });

  void listening.then(
    () => trace("native drag listener READY"),
    (err) => trace(`native drag listener FAILED: ${String(err)}`),
  );

  window.__codesuFileDropTeardown = () => {
    for (const off of undo) off();
    void listening.then((un) => un()).catch(() => {});
  };
  window.__codesuFileDrop = listening;
  return listening;
}
