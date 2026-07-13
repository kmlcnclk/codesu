import { invoke, Channel } from "@tauri-apps/api/core";

export interface TerminalHandle {
  /** Refit the terminal to its container (call after showing a hidden terminal). */
  fit: () => void;
  /** Focus the terminal. */
  focus: () => void;
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
  /** Called with each decoded chunk of PTY output (for the activity monitor). */
  onOutput?: (text: string) => void;
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

  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (err) {
    console.warn("[Codesu] WebGL renderer unavailable, using DOM renderer", err);
  }

  try {
    fitAddon.fit();
  } catch {
    /* container not visible yet; resize happens when shown */
  }

  // Cell height depends on the monospace font's metrics; if the font is still
  // loading, the first fit can miscount rows and clip the bottom line. Refit
  // once fonts are ready.
  document.fonts?.ready
    .then(() => {
      try {
        fitAddon.fit();
      } catch {
        /* container not visible yet */
      }
    })
    .catch(() => {});

  // Rust -> terminal. Raw InvokeResponseBody arrives as an ArrayBuffer.
  // A streaming decoder mirrors the same bytes to the activity monitor as text.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const emit = (bytes: Uint8Array) => {
    term.write(bytes);
    if (options.onOutput) options.onOutput(decoder.decode(bytes, { stream: true }));
  };
  const onData = new Channel<unknown>();
  onData.onmessage = (msg: unknown) => {
    if (msg instanceof ArrayBuffer) emit(new Uint8Array(msg));
    else if (msg instanceof Uint8Array) emit(msg);
    else if (Array.isArray(msg)) emit(new Uint8Array(msg as number[]));
    else if (typeof msg === "string") {
      term.write(msg);
      options.onOutput?.(msg);
    }
  };

  await invoke("start_pty", {
    id,
    cols: term.cols,
    rows: term.rows,
    shell: options.shell ?? null,
    cwd: options.cwd ?? null,
    run: options.run ?? null,
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

  // Plain Enter submits. First trim leading/trailing whitespace (blank lines AND
  // spaces) from the prompt: clear claude's buffer with one Backspace per tracked
  // character (the cursor sits at the end after linear typing, and Backspace
  // joins lines), retype the trimmed text, then submit with a carriage return —
  // all in one write so the bytes arrive in order. Verified against the claude
  // CLI editor (kitty mode on). If the buffer is untrackable or needs no trim,
  // submit as-is so we never corrupt what the user typed.
  const submit = () => {
    const trimmed = buf.trim();
    // Wrap the retyped text in bracketed-paste markers (ESC[200~ ... ESC[201~)
    // so the trailing carriage return is unambiguously a SUBMIT: without the
    // markers claude's fast-input heuristic treats the whole burst as one paste
    // and swallows the CR as a newline, so it took two Enters to send. The
    // ESC[201~ ends the paste, so the CR after it submits in one Enter.
    const seq =
      trackable && buf.length > 0 && trimmed !== buf
        ? "\x7f".repeat(buf.length) + "\x1b[200~" + trimmed + "\x1b[201~" + "\r"
        : "\r";
    invoke("write_pty", { id, data: seq }).catch(() => {});
    options.onInput?.(seq);
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

    if (k === "Enter") {
      if ((event.shiftKey || event.altKey) && !event.ctrlKey && !event.metaKey) {
        buf += "\n";
        invoke("write_pty", { id, data: "\n" }).catch(() => {});
        options.onInput?.("\n");
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

  const resizeDisp = term.onResize(({ cols, rows }) => {
    invoke("resize_pty", { id, cols, rows }).catch(() => {});
  });

  let frame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fitAddon.fit());
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
        viewportElement.addEventListener("scroll", handler);
        return () => viewportElement.removeEventListener("scroll", handler);
      })()
    : () => {};

  return {
    fit: () => {
      try {
        fitAddon.fit();
      } catch {
        /* container not visible yet */
      }
    },
    focus: () => term.focus(),
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
      ro.disconnect();
      scrollDisp();
      dataDisp.dispose();
      resizeDisp.dispose();
      invoke("kill_pty", { id }).catch(() => {});
      term.dispose();
    },
  };
}
