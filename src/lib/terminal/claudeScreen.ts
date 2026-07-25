/**
 * Reading Claude Code's live turn state off its rendered screen.
 *
 * Kept as a pure function of the screen text so it can be checked against real
 * captured frames (see the marker table below) without an app, a store or a PTY.
 *
 * The markers were verified against Claude Code v2.1.220 by driving real sessions in tmux
 * and capturing `capture-pane` output — the same rendered text xterm's buffer holds. The
 * signals never overlapped across the captured frames:
 *
 *   frame                     "esc to interrupt"  "Esc to cancel"  empty "❯" row
 *   working (thinking)                yes               no              yes
 *   working (tool running)            yes               no              yes
 *   idle / finished turn              no                no              yes
 *   tool-permission dialog            no                yes             no
 *   folder-trust dialog               no                yes             no
 *
 * Note what is NOT in that table: "? for shortcuts". It is only in the idle hint row in
 * MANUAL mode — auto mode collapses that row to "⏵⏵ auto mode on (shift+tab to cycle) ·
 * ← for agents" — so nothing may depend on it alone. The empty input-box row is the
 * mode-independent evidence that Claude is at rest rather than blocking.
 */

/**
 * Claude's status line hint, shown for exactly as long as a turn is running: the
 * bottom hint row reads "… esc to interrupt …" while working and "… ? for shortcuts …"
 * once the turn ends.
 *
 * Matched against {@link statusTail} ONLY — never the whole grid. These phrases are
 * ordinary English that a turn's own output can print (this very file, a `grep`, a chat
 * about Claude), and a transcript copy sitting in the scrollback would otherwise pin the
 * agent in "working" until it scrolled off: no done chime, no roster promotion, ever.
 */
const WORKING_MARKERS = [/esc to interrupt/i];

/**
 * How many NON-EMPTY rows from the bottom count as Claude's live status area.
 *
 * Measured on Claude Code v2.1.220 in tmux at both 100x30 and 60x20 (`capture-pane`,
 * the same rendered text xterm's buffer holds). Every marker this module looks for
 * lands within the last four:
 *
 *   working    …  1 "⏸ manual mode on · esc to interrupt · ← for agents"   ← hint row
 *                 2 "──────────" (input box bottom)
 *                 3 "❯ "        (input box)
 *                 4 "──────────" (input box top)
 *   permission …  1 "Esc to cancel · Tab to amend"
 *                 2 "  3. No"        3 "  2. Yes, allow all edits…"       4 "❯ 1. Yes"
 *
 * Five buys one row of slack without reaching the transcript: in the captured frame
 * that reproduces the bug — Claude idle, having just printed "esc to interrupt" and
 * "No, and tell Claude what to do" as output — those lines are the 6th and 7th
 * non-empty rows up, safely outside the window.
 */
const STATUS_TAIL_ROWS = 5;

/**
 * The bottom region of the screen, where Claude paints its live status line and its
 * dialogs. Counted in non-empty rows because the region floats: a short session leaves
 * blank rows under the transcript, and a permission dialog can be drawn well above the
 * bottom of a tall pane with nothing beneath it.
 */
function statusTail(screen: string): string {
  const lines = screen.split("\n");
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < STATUS_TAIL_ROWS; i--) {
    if (lines[i].trim()) tail.push(lines[i]);
  }
  tail.reverse();
  // Three renderings of the same rows, because a marker can be reflowed across a row
  // boundary in a narrow pane (a four-way split can leave ~25 columns) and then matches
  // no single row — a mid-turn frame reads as quiet and fires the done chime while
  // Claude is still working.
  //   • as-is       — the normal case, and the only one that can't fuse unrelated rows
  //   • glued       — wrap fell mid-word: "inter" + "rupt"
  //   • space-fused — wrap fell on a space, which trimEnd has since eaten: "esc" + "to …"
  const asIs = tail.join("\n");
  const glued = tail.map((r) => r.trimEnd()).join("");
  const spaceFused = tail.join(" ").replace(/\s+/g, " ");
  return `${asIs}\n${glued}\n${spaceFused}`;
}

/**
 * Claude is waiting on an answer. Every blocking prompt it draws (tool permission,
 * plan approval, folder trust) replaces the input box with a numbered select list and
 * a dialog-only hint row containing "Esc to cancel".
 *
 * Confined to {@link statusTail} for the same reason as {@link WORKING_MARKERS}: these
 * are option labels, and a transcript that merely quotes one ("No, and tell Claude …")
 * would otherwise conjure a phantom dialog, complete with its chime. A real dialog draws
 * them in the bottom region — and a variant that somehow drew them higher still lands as
 * "blocked" via the select-list fallback below.
 */
const DIALOG_MARKERS = [
  /\besc to cancel\b/i, // the hint row of every blocking dialog
  /No, and tell Claude/i, // the "reject with feedback" option label
  /Do you trust the files/i, // folder-trust prompt
];

/**
 * The select cursor of a numbered dialog, e.g. "❯ 1. Yes". A fallback for a future
 * dialog that drops the hint row above, and deliberately the weaker signal of the two:
 * a submitted user message is echoed as "❯ <text>", so a prompt whose first line reads
 * "1. do this" renders as "❯ 1. do this" as well. Two guards keep that apart from a real
 * dialog — the cursor must have a sibling option to select ({@link DIALOG_SIBLING}), and
 * the idle input hint must be absent, since Claude is plainly at rest while that is up.
 */
const DIALOG_CURSOR = /❯\s*(\d+)\.\s/;
/**
 * A second, un-selected numbered option — every Claude select prompt offers ≥ 2.
 * Global and hoisted: {@link hasSelectList} scans it with `matchAll` on every monitor
 * tick (4×/s per changed agent), and `matchAll` runs against a CLONE of the regex, so
 * this one's `lastIndex` stays 0 and it is safe to share.
 */
const DIALOG_SIBLING = /^\s+(\d+)\.\s+\S/gm;
/**
 * Evidence that Claude is NOT waiting on a dialog, because it is offering its input box:
 * either the idle hint row, or the empty prompt row of the box itself.
 *
 * The empty prompt row is the load-bearing one. The hint row is mode-dependent — it reads
 * "⏸ manual mode on · ? for shortcuts · ← for agents" when idle in manual mode, but in
 * auto mode it collapses to "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents" with no
 * "? for shortcuts" at all (captured). Matching only that would drop this guard entirely
 * for anyone running in auto mode. An empty "❯" row, by contrast, appears in every idle
 * and working frame and in none of the dialogs — a blocking dialog replaces the box.
 * (It must be the EMPTY row: a submitted message is echoed as "❯ <text>", which shows up
 * above dialogs too, so "❯ " with content proves nothing.)
 */
const AT_REST_MARKERS = [/^❯\s*$/m, /\?\s+for shortcuts/i];

/** A numbered select list is on screen: a cursor plus at least one other option. */
function hasSelectList(screen: string): boolean {
  const cursor = DIALOG_CURSOR.exec(screen);
  if (!cursor) return false;
  // The sibling must be a DIFFERENT option, or "❯ 1. foo" plus its own indented
  // continuation line would satisfy this on its own.
  for (const m of screen.matchAll(DIALOG_SIBLING)) {
    if (m[1] !== cursor[1]) return true;
  }
  return false;
}

export type ScreenSignal = "working" | "blocked" | "quiet";

/**
 * What the terminal is showing right now. `screen` must be the LIVE screen text (see
 * `TerminalHandle.screen`), not an accumulation of past output — the whole point is
 * that a phrase Claude has erased stops counting immediately.
 *
 * "working" is checked first: while a turn is genuinely running, anything
 * dialog-shaped on screen is transcript, not a question being asked.
 *
 * The phrase markers are read from {@link statusTail} rather than the whole grid — the
 * transcript above it is Claude's OUTPUT, and output that happens to quote a marker must
 * not be mistaken for the status line drawing one.
 */
export function readScreenSignal(screen: string): ScreenSignal {
  const tail = statusTail(screen);
  if (WORKING_MARKERS.some((re) => re.test(tail))) return "working";
  if (DIALOG_MARKERS.some((re) => re.test(tail))) return "blocked";
  if (!AT_REST_MARKERS.some((re) => re.test(screen)) && hasSelectList(screen)) return "blocked";
  return "quiet";
}

// ---------- dialog option geometry ----------
//
// Where the options of an on-screen select dialog sit, so a mouse click can be mapped to
// the option it landed on. Pure over the screen lines, like everything above.

/** The options of a numbered select dialog, located on screen. */
export interface SelectList {
  /** Row of each option's first line, in visual order — indices into the input lines. */
  rows: number[];
  /** Index into {@link rows} of the option the ❯ cursor is currently on. */
  cursor: number;
}

/**
 * An option row. Leading box-drawing characters are tolerated because Claude draws most
 * dialogs inside a rounded border, so the real line is `│ ❯ 1. Yes`, not `❯ 1. Yes`.
 */
const OPTION_LINE = /^[\s│┃|╎┆]*(❯)?\s*(\d+)\.\s+\S/;

/**
 * Locate the numbered select list on screen, or null if there isn't one.
 *
 * Only the run of CONSECUTIVELY numbered options containing the cursor is kept, so a
 * numbered list sitting in the transcript above the dialog can never be absorbed into it.
 * A lone `❯ 1. …` is rejected for the same reason {@link hasSelectList} rejects it: a
 * submitted user message is echoed with the same cursor glyph.
 *
 * `hoverRow` is the row under the mouse pointer, if any. Claude paints a SECOND `❯` on
 * the row being hovered, identical in text to the keyboard cursor, so a screen can carry
 * two of them. That marker is decoration only — verified against a live session, where
 * hovering option 4 and pressing Enter still chose option 1 — and mistaking it for the
 * cursor is fatal here, since it always sits on the very row that was clicked (making
 * every move look like a zero-length one). Naming the hovered row lets it be discounted.
 */
export function readSelectList(lines: string[], hoverRow = -1): SelectList | null {
  const found: { row: number; n: number; cursor: boolean }[] = [];
  lines.forEach((line, row) => {
    const m = OPTION_LINE.exec(line);
    if (m) found.push({ row, n: Number(m[2]), cursor: !!m[1] });
  });

  // The LAST cursor on screen, preferring one that is not the hover marker: a dialog is
  // always drawn at the bottom, below any echoed user message carrying the same glyph.
  // Falling back to the hovered row covers the pointer resting on the real cursor, where
  // the two markers coincide and there is nowhere to move anyway.
  const lastCursor = (skipHover: boolean) => {
    for (let i = found.length - 1; i >= 0; i--) {
      if (found[i].cursor && !(skipHover && found[i].row === hoverRow)) return i;
    }
    return -1;
  };
  let at = lastCursor(true);
  if (at < 0) at = lastCursor(false);
  if (at < 0) return null; // no cursor: nothing to move, and no way to know where from

  let lo = at;
  let hi = at;
  while (lo > 0 && found[lo - 1].n === found[lo].n - 1) lo--;
  while (hi + 1 < found.length && found[hi + 1].n === found[hi].n + 1) hi++;
  if (hi === lo) return null; // a single option is an echoed message, not a dialog

  return { rows: found.slice(lo, hi + 1).map((o) => o.row), cursor: at - lo };
}

/**
 * Which option covers screen row `row`, or null if the click missed the list.
 *
 * An option owns every row from its own down to the next option's, which keeps clicks on
 * a wrapped second line working. The last option is given the same height as the gap that
 * precedes it, so the dialog's hint row below the list stays outside the list.
 */
export function selectOptionAtRow(list: SelectList, row: number): number | null {
  const { rows } = list;
  if (row < rows[0]) return null;
  for (let i = 0; i < rows.length; i++) {
    const height = i + 1 < rows.length ? rows[i + 1] - rows[i] : rows[i] - rows[i - 1];
    if (row < rows[i] + Math.max(1, height)) return i;
  }
  return null;
}

// ---------- turn state machine ----------
//
// Turning that per-tick reading into an agent state, a "turn started" event and at most
// one chime per event. Kept a pure reducer over an explicit memo so the chime semantics
// — the part users actually feel — can be tested directly against tick sequences,
// without a store, a PTY or a clock.

/**
 * A raw reading must hold this long before it commits. Ink repaints by erasing and
 * redrawing its region, so a reading can land in the gap where the status line is
 * momentarily absent; without this debounce that gap fires a premature "done" chime and
 * flickers the badge. Entering "working" is exempt — Claude's own status line being on
 * screen is unambiguous, and responsiveness matters most there.
 */
export const SETTLE_MS = 450;

/** Everything the reducer remembers between ticks. One per agent, mutated in place. */
export interface TurnMemo {
  /** Last raw reading. */
  signal: ScreenSignal | "unknown";
  /** When {@link signal} first read that way — the debounce clock. */
  signalSince: number;
  /** A reading is waiting to settle; the caller must keep ticking us. */
  pending: boolean;
  /** Inside a turn: Claude's status line has been on screen. */
  spell: boolean;
  /** A finished turn is waiting to be reviewed (what holds "done"). */
  reviewPending: boolean;
  /** The blocked chime already sounded for the dialog CURRENTLY on screen. */
  alertedBlocked: boolean;
}

export function freshTurnMemo(): TurnMemo {
  return {
    signal: "unknown",
    signalSince: 0,
    pending: false,
    spell: false,
    reviewPending: false,
    alertedBlocked: false,
  };
}

/** The live states this reducer derives (a subset of the store's AgentState). */
export type TurnState = "working" | "blocked" | "done" | "idle";

export interface TurnStep {
  /** The state to commit, or null while a reading is still settling. */
  state: TurnState | null;
  /** A new turn just began — worth recording as activity. */
  turnStarted: boolean;
  /** Sound to play, at most one per genuine event. */
  chime: "done" | "blocked" | null;
}

/**
 * Advance one tick. `memo` is mutated; the returned step says what the caller should do.
 *
 * Guarantees, all covered by tests:
 *   - "working" commits on the first reading, so the UI reacts immediately;
 *   - every other reading is debounced by {@link SETTLE_MS};
 *   - exactly one "done" chime per turn, and it never fires for an agent that was never
 *     working (a bare shell prompt, a relaunch, a resumed session);
 *   - exactly one "blocked" chime per dialog, no matter how often Claude redraws it,
 *     and a NEW dialog after work resumes chimes again.
 */
export function stepTurn(memo: TurnMemo, signal: ScreenSignal, now: number): TurnStep {
  if (signal !== memo.signal) {
    memo.signal = signal;
    memo.signalSince = now;
  }
  if (signal !== "working" && now - memo.signalSince < SETTLE_MS) {
    memo.pending = true; // keep looking: an unchanged screen still has to settle
    return { state: null, turnStarted: false, chime: null };
  }
  memo.pending = false;

  const state: TurnState =
    signal === "working"
      ? "working"
      : signal === "blocked"
        ? "blocked"
        : // Quiet: a turn that just ended is "done" and stays "done" until reviewed;
          // otherwise the agent is simply at rest.
          memo.spell || memo.reviewPending
          ? "done"
          : "idle";

  const step: TurnStep = { state, turnStarted: false, chime: null };

  if (state === "working" && !memo.spell) {
    memo.spell = true; // the status line came up where there was none
    step.turnStarted = true;
  }
  if (state === "blocked") {
    // Keep the spell: answering resumes the same turn, which then ends as "done".
    if (!memo.alertedBlocked) {
      memo.alertedBlocked = true;
      step.chime = "blocked";
    }
  } else {
    memo.alertedBlocked = false; // dialog gone → the next question may chime again
  }
  if (state === "done" && memo.spell) {
    memo.spell = false;
    memo.reviewPending = true;
    step.chime = "done";
  }
  return step;
}
