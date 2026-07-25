import { invoke, Channel } from "@tauri-apps/api/core";
import { readScreenSignal, readSelectList, selectOptionAtRow } from "./claudeScreen";

export interface TerminalHandle {
  /** Refit the terminal to its container (call after showing a hidden terminal). */
  fit: () => void;
  /** Focus the terminal. */
  focus: () => void;
  /**
   * Plain text of the bottom `maxRows` rows of the LIVE screen, read straight out of
   * xterm's own buffer. This is what the terminal is actually displaying right now —
   * not a guess reassembled from the raw byte stream — which is what the activity
   * monitor reads Claude's status line / prompt dialogs from. Always measured from
   * `baseY`, so the user scrolling back never changes the result.
   */
  screen: (maxRows?: number) => string;
  /** Get current scroll position (buffer line where viewport top is). */
  getScrollPosition: () => number;
  /** Set scroll position (buffer line to scroll to). */
  setScrollPosition: (pos: number) => void;
  /** Tear down: kill the PTY, dispose xterm, stop observers. */
  dispose: () => void;
}

export interface TerminalOptions {
  /** Optional shell override (defaults to $SHELL). */
  shell?: string | null;
  /** Optional working directory (defaults to $HOME). */
  cwd?: string | null;
  /** Optional command auto-run in the shell (e.g. "claude"). */
  run?: string | null;
  /**
   * Environment overrides for the spawned shell, applied on top of the inherited
   * environment. Used to give a Claude agent its own config dir (and so its own prompt
   * history) — see `claude_home` on the Rust side.
   */
  env?: Record<string, string> | null;
  /**
   * Called once per chunk of PTY output (for the activity monitor). Deliberately
   * payload-free: the monitor reads state from {@link TerminalHandle.screen}, so the
   * bytes never have to be decoded to a string here.
   */
  onOutput?: () => void;
  /** Called with each keystroke the user sends (for the activity monitor). */
  onInput?: (data: string) => void;
}

/**
 * Mounts an xterm.js terminal into `container` and wires it to a Rust PTY keyed by `id`.
 *
 *   Rust PTY --(raw bytes over ipc::Channel)--> term.write()
 *   term.onData (keystrokes) --(invoke write_pty)--> Rust PTY
 *   fit addon --(invoke resize_pty)--> Rust PTY
 *
 * xterm and its addons are imported dynamically so they never run during SSR/prerender.
 */
export async function createTerminal(
  container: HTMLElement,
  id: string,
  options: TerminalOptions = {},
): Promise<TerminalHandle> {
  const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-webgl"),
  ]);
  await import("@xterm/xterm/css/xterm.css");

  const term = new Terminal({
    fontFamily:
      'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 5000,
    // xterm defaults to 1 line per wheel notch, which feels painfully slow. Bump
    // both so mouse-wheel scrolling covers real ground. (These apply to line/page
    // wheel deltas; trackpad pixel-scrolling is 1:1 and unaffected.)
    scrollSensitivity: 5,
    fastScrollSensitivity: 10,
    cursorBlink: true,
    allowProposedApi: true,
    // Kept in sync with the CSS theme tokens in src/app.css (xterm needs literal
    // color strings, so these can't reference var(--…)).
    theme: {
      background: "#0a0c11", // --term-bg
      foreground: "#e9eef6", // --text
      cursor: "#6e8bff", // --accent
      cursorAccent: "#0a0c11",
      selectionBackground: "#2b3566", // indigo-tinted selection
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  /**
   * Is the terminal actually laid out? FitAddon sizes the grid from
   * `parseInt(getComputedStyle(parent).width)`, and for an element that generates no
   * box (any `display:none` ancestor — a hidden tab, a hidden view) the resolved value
   * of a percentage size is the COMPUTED value, i.e. the literal string "100%". Our
   * `.term { width: 100%; height: 100% }` therefore parses as 100px x 100px and fits to
   * an ~11x6 grid. Handing that to the PTY is not just cosmetic: `claude` paints its
   * welcome banner ONCE, at whatever width it was started with, so the banner stays
   * wrapped into a ~10-column ribbon for the rest of the session even after the pane is
   * shown and resized. `clientWidth/Height` are 0 for a non-rendered element, which
   * makes them a reliable "does this have a layout box?" test.
   */
  const isRendered = () => container.clientWidth > 0 && container.clientHeight > 0;

  /** Fit to the container — a no-op unless the terminal is really on screen. */
  const fit = () => {
    if (!isRendered()) return;
    try {
      fitAddon.fit();
    } catch {
      /* transient layout state */
    }
  };

  /**
   * Resolve once the container has a layout box. Bounded, because a pane can legitimately
   * stay hidden for a long time — an agent started from the Tasks page while another view
   * is on screen must still get to work. On timeout we fall through with xterm's 80x24
   * default, which the ResizeObserver corrects the moment the pane is shown.
   */
  const waitForLayout = (timeoutMs = 2500) =>
    new Promise<void>((resolve) => {
      if (isRendered()) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      };
      // A display:none -> displayed transition surfaces here as a 0x0 -> WxH resize.
      const observer = new ResizeObserver(() => {
        if (isRendered()) finish();
      });
      observer.observe(container);
      const timer = setTimeout(finish, timeoutMs);
    });

  // Load the WebGL renderer, and RE-LOAD it if the GPU context is lost. WKWebView
  // drops the WebGL context on things like tab switches or display sleep; the old
  // code only disposed the addon on loss, leaving xterm on its slow DOM renderer
  // for the rest of the session — that showed up as permanently laggy scrolling.
  // Recreating the addon keeps hardware rendering (and smooth scroll) alive.
  //
  // But BOUNDED, because this app opens many terminals at once. WKWebView caps how many
  // live WebGL contexts it will hand out (~16) and evicts the oldest to honour a new one,
  // so past that cap every rebuild costs another pane its context — which rebuilds, which
  // evicts another — a self-feeding churn loop of flicker and wasted CPU across every open
  // terminal. After a few losses this terminal stops asking and lives on the DOM renderer:
  // slower to scroll, but stable, and one pane paying that price is far better than all of
  // them thrashing.
  const WEBGL_MAX_RELOADS = 3;
  const WEBGL_RELOAD_MS = 750;
  let webglReloads = 0;
  let webglTimer: ReturnType<typeof setTimeout> | undefined;
  const loadWebgl = () => {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (webglReloads >= WEBGL_MAX_RELOADS) {
          // Logged once per terminal: with no addon loaded there is no context left to
          // lose, so this is the last thing this handler ever says.
          console.warn(
            `[Codesu] WebGL context lost ${webglReloads + 1}x, staying on the DOM renderer`,
          );
          return;
        }
        webglReloads++;
        // Backed off rather than immediate: a 0ms retry races the very eviction that
        // caused the loss, and reliably re-triggers it.
        webglTimer = setTimeout(loadWebgl, WEBGL_RELOAD_MS);
      });
      term.loadAddon(webgl);
    } catch (err) {
      console.warn("[Codesu] WebGL renderer unavailable, using DOM renderer", err);
    }
  };
  loadWebgl();

  // Get the grid right BEFORE the PTY exists — the shell and everything it runs
  // inherit these dimensions for their first frame, and a TUI like `claude` paints
  // its banner once, at the width it started with. So: wait for the pane to have a
  // layout box, and for the font (cell metrics decide cols/rows) to be ready.
  await waitForLayout();
  await document.fonts?.ready.catch(() => {});
  fit();

  // Rust -> terminal. Raw InvokeResponseBody arrives as an ArrayBuffer.
  //
  // onOutput is fired from write()'s CALLBACK, not straight after the call: xterm parses
  // asynchronously and its own docs are explicit that `buffer` does not reflect a write
  // until the callback runs. Notifying early would tell the activity monitor "the screen
  // changed" while it still holds the previous frame — and under heavy output, where the
  // parser deliberately yields, that lag is unbounded.
  //
  // The same callback stamps `screenSeq`, a counter the mouse handling below uses to know
  // when its reading of the screen is still good — mousemove fires far more often than
  // the screen changes, and re-scanning the whole grid per event would be wasteful.
  let screenSeq = 0;
  const emit = (data: Uint8Array | string) => {
    term.write(data, () => {
      screenSeq++;
      options.onOutput?.();
    });
  };
  const onData = new Channel<unknown>();
  onData.onmessage = (msg: unknown) => {
    if (msg instanceof ArrayBuffer) emit(new Uint8Array(msg));
    else if (msg instanceof Uint8Array) emit(msg);
    else if (Array.isArray(msg)) emit(new Uint8Array(msg as number[]));
    else if (typeof msg === "string") emit(msg);
  };

  await invoke("start_pty", {
    id,
    cols: term.cols,
    rows: term.rows,
    shell: options.shell ?? null,
    cwd: options.cwd ?? null,
    run: options.run ?? null,
    env: options.env ?? null,
    onData,
  });

  // We mirror the current prompt in `buf` so that, on Enter, we can trim leading
  // and trailing whitespace before it reaches the agent. `claude` enables the
  // kitty keyboard protocol and modifyOtherKeys, so xterm reports ordinary keys
  // to onData as ESCAPE SEQUENCES, not plain characters — byte-level tracking is
  // hopeless. Instead we track from KEY EVENTS (event.key), which give the real
  // character regardless of terminal encoding. `trackable` drops to false the
  // moment something we can't model happens (cursor keys, paste, command chords);
  // then we submit exactly what was typed rather than risk corrupting it.
  let buf = "";
  let trackable = true;

  const dataDisp = term.onData((data: string) => {
    invoke("write_pty", { id, data }).catch(() => {});
    options.onInput?.(data);
    if (data.includes("\x1b[200~")) trackable = false; // bracketed paste we didn't track
  });

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  // Returning false makes xterm skip its own key processing, but it does NOT call
  // event.preventDefault() for us, so the browser's default action would still
  // fire on xterm's hidden textarea (Enter inserts a newline there, which xterm
  // then sends as a submitting carriage return, clobbering our sequence). That
  // leak was the original Shift+Enter bug; handled() suppresses the native default.
  const handled = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    return false;
  };

  // Send a chunk to the PTY and mirror it to the activity monitor.
  const write = (data: string) => {
    invoke("write_pty", { id, data }).catch(() => {});
    options.onInput?.(data);
  };

  // Plain Enter submits, optionally trimming leading/trailing whitespace first.
  //
  // The trim MUST NOT corrupt input, so it is deliberately conservative:
  //   - Only when the prompt is fully `trackable` (pure linear typing, cursor at
  //     the end) and single-line — we never backspace across newlines, which is
  //     where the old code mangled multi-line prompts.
  //   - Trailing-only whitespace (the common case, e.g. a stray end space) is
  //     removed by deleting exactly those characters — no full-line retype.
  //   - Leading whitespace additionally needs a retype; that text is wrapped in
  //     bracketed-paste markers so claude treats it as pasted content.
  //
  // The submitting carriage return is ALWAYS sent as a SEPARATE, deferred write.
  // Sending the edit and the CR in one burst let claude's paste-detection
  // heuristic fold them together and swallow the CR as a newline — that was the
  // "double Enter" bug. A tiny gap makes the CR read as a real submit keypress.
  const submit = () => {
    const trimmed = buf.trim();
    const canTrim = trackable && buf.length > 0 && !buf.includes("\n") && trimmed !== buf;

    if (!canTrim) {
      write("\r"); // nothing to trim (or untrackable/multi-line): submit verbatim
    } else {
      const edit = buf.startsWith(trimmed)
        ? "\x7f".repeat(buf.length - trimmed.length) // trailing whitespace only
        : "\x7f".repeat(buf.length) + "\x1b[200~" + trimmed + "\x1b[201~";
      write(edit);
      setTimeout(() => write("\r"), 12); // separate keypress → reliable single-Enter submit
    }
    buf = "";
    trackable = true;
  };

  // Pure modifier keydowns don't change the buffer and must not disable tracking.
  const MODIFIER_KEYS = new Set([
    "Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock", "AltGraph",
  ]);

  // Single custom key handler (xterm keeps only ONE). Handles newline-vs-submit,
  // clipboard shortcuts, AND mirrors keystrokes into `buf` for submit-time trim.
  //   Enter            -> submit (trimmed, see submit())
  //   Shift/Alt+Enter  -> newline (line feed `\n`; claude treats it as a newline,
  //                       never a submit; verified empirically)
  //   Cmd / Ctrl+Shift A/C/X -> Select All / Copy / Cut (canvas render hides the
  //                       selection from the browser, so these are wired manually)
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== "keydown") return true;
    const k = event.key;

    // Cmd+Backspace belongs to the app ("Close Current Agent"), not the shell. xterm
    // maps Backspace to DEL without ever looking at metaKey, then cancels the event —
    // so left alone this both eats the shortcut and deletes a character out of whatever
    // the user was typing to Claude. Returning false is what keeps xterm's hands off it
    // and lets it reach the window handler in +page.svelte.
    if (k === "Backspace" && event.metaKey) return false;

    if (k === "Enter") {
      if ((event.shiftKey || event.altKey) && !event.ctrlKey && !event.metaKey) {
        buf += "\n";
        write("\n");
        return handled(event);
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        submit();
        return handled(event);
      }
      return true; // other Enter chords pass through
    }

    const clipboardChord = isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    if (clipboardChord) {
      switch (k.toLowerCase()) {
        case "a": // Select All
          term.selectAll();
          return handled(event);
        case "c": // Copy
        case "x": { // Cut cannot delete scrollback, so it is a best-effort copy
          const sel = term.getSelection();
          if (sel) {
            navigator.clipboard?.writeText(sel).catch(() => {});
            return handled(event);
          }
          return true; // nothing selected: don't swallow the chord
        }
        case "v": // Paste: content we can't track -> submit as-is afterwards
          trackable = false;
          return true;
      }
    }

    // Mirror the keystroke into our buffer model (encoding-immune via event.key).
    if (event.ctrlKey || event.metaKey) {
      if (event.ctrlKey && k === "c") {
        buf = ""; // Ctrl+C clears the current prompt
        trackable = true;
      } else {
        trackable = false; // other command chords: effect on the buffer is unknown
      }
    } else if (k === "Backspace") {
      buf = buf.slice(0, -1);
    } else if (k.length === 1) {
      buf += k; // a printable character (letter, digit, space, punctuation)
    } else if (!MODIFIER_KEYS.has(k)) {
      trackable = false; // arrows, Home/End, Delete, Tab, Escape, F-keys, IME, etc.
    }
    return true;
  });

  // ---------- clicking a dialog option MOVES the cursor, it never answers ----------
  //
  // Claude enables any-event mouse tracking (`?1003h` + SGR `?1006h`) once its REPL is
  // up, so every pointer move and click inside a select dialog is forwarded to the PTY.
  // Three behaviours were measured by injecting synthetic SGR reports into a real
  // session's PTY (Claude Code 2.1.220), and all three shape the code below:
  //
  //   1. The mouse RELEASE answers the dialog — the press alone does nothing. So it is
  //      the release that must never get through; letting a press pass and swallowing
  //      only the click would still submit.
  //   2. A pointer MOVE paints a second `❯` on the hovered row, identical in text to the
  //      keyboard cursor.
  //   3. That hover marker is decoration: hovering option 4 and pressing Enter still
  //      chose option 1. It shows a selection the keyboard does not agree with.
  //
  // So while a dialog is up we take the whole gesture — move, press, release, click —
  // away from xterm, which kills the lying hover marker, and translate a click into the
  // arrow keys that walk the REAL cursor onto the clicked option. Enter then answers,
  // and what is highlighted is what gets chosen.
  //
  // Deliberately narrow: only a plain left click, only while the live screen is showing
  // a numbered select list, and only over the grid. Everything else — Alt-drag to force
  // a selection, wheel, any other TUI — reaches xterm untouched.

  /** The `.xterm-screen` box, which is exactly the character grid (no padding). */
  const gridEl = () => container.querySelector(".xterm-screen") as HTMLElement | null;

  /** Viewport row under the pointer, or null if the pointer is outside the grid. */
  const rowAt = (e: MouseEvent): number | null => {
    const rect = gridEl()?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return null;
    if (e.clientX < rect.left || e.clientX >= rect.right) return null;
    if (e.clientY < rect.top || e.clientY >= rect.bottom) return null;
    const row = Math.floor(((e.clientY - rect.top) / rect.height) * term.rows);
    return Math.min(term.rows - 1, Math.max(0, row));
  };

  /** The rows of the LIVE screen (from `baseY`), i.e. what the activity monitor reads. */
  const liveLines = (): string[] => {
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < term.rows; y++) {
      lines.push(b.getLine(b.baseY + y)?.translateToString(true) ?? "");
    }
    return lines;
  };

  /**
   * The live screen while a dialog is up, else null. Recomputed only when xterm has
   * parsed new output, which makes it cheap enough to call from every mousemove and,
   * unlike a time-based throttle, never stale: a dialog is recognised on the very first
   * event after the frame that drew it, leaving no window in which a motion report could
   * slip through and paint a hover marker.
   */
  let seenSeq = -1;
  let dialogScreen: string[] | null = null;
  const liveDialog = (): string[] | null => {
    if (seenSeq !== screenSeq) {
      seenSeq = screenSeq;
      const lines = liveLines();
      dialogScreen = readScreenSignal(lines.join("\n")) === "blocked" ? lines : null;
    }
    return dialogScreen;
  };

  /**
   * The live row under the pointer while a dialog is up, or null if this gesture is none
   * of our business. Anchored to `baseY` rather than to the viewport, because the pane
   * restores its scroll position when shown and can sit a row or two off the bottom — the
   * dialog is still live and clickable there. A pointer over real scrollback has no live
   * row and is left alone.
   */
  const dialogRowAt = (e: MouseEvent): { row: number; lines: string[] } | null => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
    const lines = liveDialog();
    if (!lines) return null;
    const row = rowAt(e);
    if (row === null) return null;
    const b = term.buffer.active;
    const liveRow = b.viewportY + row - b.baseY;
    if (liveRow < 0 || liveRow >= term.rows) return null;
    return { row: liveRow, lines };
  };

  /** Walk the cursor onto the clicked option. Returns true if the event was consumed. */
  const steerDialog = (e: MouseEvent): boolean => {
    if (e.button !== 0) return false;
    const at = dialogRowAt(e);
    if (!at) return false;

    // Consume the gesture from here on: a dialog is up and the pointer is over the live
    // grid, so nothing about this click may reach Claude — not a click on the already
    // selected option, and not one on the dialog's body, which would answer it too.
    const list = readSelectList(at.lines, at.row);
    const target = list && selectOptionAtRow(list, at.row);
    if (list && target !== null) {
      const delta = target - list.cursor;
      if (delta !== 0) write((delta > 0 ? "\x1b[B" : "\x1b[A").repeat(Math.abs(delta)));
    }
    return true;
  };

  // preventDefault() on mousedown also blocks the focus that click would have given
  // xterm's hidden textarea, so focus is taken explicitly — Enter has to land here next.
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  // Capture phase on the container runs before xterm's own listeners on its descendants.
  // Both halves of the gesture matter: xterm reports the press from `mousedown` and then
  // registers a document-level `mouseup` to report the release — the one Claude answers
  // on — so the press must be stopped before that listener is ever attached, and the
  // release stopped too in case the press began outside the grid.
  let swallowing = false;
  const onMouseDown = (e: MouseEvent) => {
    swallowing = steerDialog(e);
    if (!swallowing) return;
    swallow(e);
    term.focus();
  };
  const onMouseRest = (e: MouseEvent) => {
    if (!swallowing && !(e.type === "mouseup" && e.button === 0 && dialogRowAt(e))) return;
    if (e.type === "click") swallowing = false;
    swallow(e);
  };
  // Motion is swallowed too, and every single event of it: the hover marker Enter does
  // not honour can only be painted by a motion report, so suppressing all of them while a
  // dialog is up leaves exactly one ❯ on screen — the real cursor. That is what makes the
  // delta below trustworthy. preventDefault() is deliberately not called; stopping the
  // propagation is enough to keep xterm from reporting, and mousemove has no default
  // worth suppressing.
  const onMouseMove = (e: MouseEvent) => {
    if (!dialogRowAt(e)) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  container.addEventListener("mousedown", onMouseDown, true);
  container.addEventListener("mouseup", onMouseRest, true);
  container.addEventListener("click", onMouseRest, true);
  container.addEventListener("mousemove", onMouseMove, true);

  const resizeDisp = term.onResize(({ cols, rows }) => {
    invoke("resize_pty", { id, cols, rows }).catch(() => {});
  });

  let frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  });
  ro.observe(container);

  // Track scroll position in the terminal viewport
  let lastScrollPos = 0;
  const viewportElement = container.querySelector(".xterm-viewport") as HTMLElement | null;
  const scrollDisp = viewportElement
    ? (() => {
        const handler = () => {
          lastScrollPos = viewportElement.scrollTop;
        };
        // Passive: this listener never calls preventDefault, so telling the browser
        // that up front keeps scrolling off the blocking path (smoother wheel scroll).
        viewportElement.addEventListener("scroll", handler, { passive: true });
        return () => viewportElement.removeEventListener("scroll", handler);
      })()
    : () => {};

  return {
    fit: () => {
      if (!isRendered()) return; // hidden pane: fitting here would size it to "100%" = 100px
      fit();
      // Force a redraw. When a pane is revealed after being display:none, fit()
      // is a no-op if the size is unchanged, and the WebGL renderer can leave a
      // stale/blank canvas (menus look broken/unselectable). A refresh repaints.
      term.refresh(0, term.rows - 1);
    },
    focus: () => term.focus(),
    // Read the live frame from the bottom of the buffer, defaulting to the whole
    // viewport. Anything above it is scrolled-past history and stays out of view —
    // which is what keeps the reading current without any staleness bookkeeping.
    screen: (maxRows = term.rows) => {
      const buf = term.buffer.active;
      const bottom = buf.baseY + term.rows - 1;
      const top = Math.max(0, bottom - maxRows + 1);
      const rows: string[] = [];
      for (let y = top; y <= bottom; y++) {
        const line = buf.getLine(y);
        if (line) rows.push(line.translateToString(true));
      }
      return rows.join("\n");
    },
    getScrollPosition: () => {
      // Get the current scroll position from the viewport
      const scrollElement = container.querySelector(".xterm-viewport") as HTMLElement | null;
      return scrollElement?.scrollTop ?? lastScrollPos;
    },
    setScrollPosition: (pos: number) => {
      // Restore scroll position - use multiple attempts with increasing delays
      const scrollElement = container.querySelector(".xterm-viewport") as HTMLElement | null;
      if (!scrollElement) return;

      const attempts = [0, 50, 100, 150, 250];
      attempts.forEach((delay) => {
        setTimeout(() => {
          if (scrollElement && pos > 0) {
            scrollElement.scrollTop = pos;
          }
        }, delay);
      });
    },
    dispose: () => {
      cancelAnimationFrame(frame);
      clearTimeout(webglTimer); // a pending WebGL rebuild must not outlive the terminal
      ro.disconnect();
      scrollDisp();
      container.removeEventListener("mousedown", onMouseDown, true);
      container.removeEventListener("mouseup", onMouseRest, true);
      container.removeEventListener("click", onMouseRest, true);
      container.removeEventListener("mousemove", onMouseMove, true);
      dataDisp.dispose();
      resizeDisp.dispose();
      invoke("kill_pty", { id }).catch(() => {});
      term.dispose();
    },
  };
}
