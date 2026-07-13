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

  const dataDisp = term.onData((data: string) => {
    invoke("write_pty", { id, data }).catch(() => {});
    options.onInput?.(data);
  });

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  // Single custom key handler (xterm keeps only ONE — a second call replaces the
  // first), covering two concerns:
  //
  // 1. Newline vs. submit, matching Claude Code's REPL:
  //      Enter                    -> submit  (`\r`, xterm default — left alone)
  //      Shift+Enter              -> newline (`\n`)
  //      Option/Alt+Enter (macOS) -> newline (`\n`)
  //    The 48-year-old VT100 limitation means most terminals send an identical
  //    carriage return (`\r`) for Enter and Shift+Enter, so Claude reads both as
  //    "submit". Native terminals solve this with the Kitty keyboard protocol
  //    (Shift+Enter -> `ESC[13;2u`), which xterm.js v6 does not negotiate. We
  //    instead write a literal line feed (`\n`) — identical to Ctrl+J, the
  //    universal newline. (Ctrl+J and `\`+Enter already work via xterm defaults.)
  //
  // 2. Clipboard shortcuts. xterm renders to canvas/WebGL, so the browser's
  //    native Cmd/Ctrl+C cannot see xterm's selection — Copy and Select All must
  //    be wired manually. Chord is Cmd+key on macOS, Ctrl+Shift+key elsewhere
  //    (plain Ctrl+C/X are reserved for SIGINT / readline). Paste is left to
  //    xterm's own textarea handler, which already routes it through bracketed
  //    paste, so intercepting it would only risk double-paste. Cut can't remove
  //    committed terminal output, so it is a non-destructive best-effort copy.
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (event.type !== "keydown") return true;

    if (event.key === "Enter") {
      if ((event.shiftKey || event.altKey) && !event.ctrlKey && !event.metaKey) {
        invoke("write_pty", { id, data: "\n" }).catch(() => {});
        options.onInput?.("\n");
        return false; // prevent xterm's default `\r`
      }
      return true;
    }

    const clipboardChord = isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;

    if (clipboardChord) {
      switch (event.key.toLowerCase()) {
        case "a": // Select All
          term.selectAll();
          return false;
        case "c": // Copy
        case "x": {
          // Cut — terminal scrollback can't be deleted, so copy without removing.
          const sel = term.getSelection();
          if (sel) {
            navigator.clipboard?.writeText(sel).catch(() => {});
            return false;
          }
          return true; // nothing selected — don't swallow the chord
        }
      }
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
