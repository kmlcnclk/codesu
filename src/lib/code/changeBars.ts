/**
 * IntelliJ's change bars: a coloured stripe in the gutter beside every line that differs
 * from the version on disk, and a click to put that block back.
 *
 * The dot on a tab tells you a file is dirty; this tells you WHERE. With an agent editing
 * the same tree underneath you, "what did I change since I opened this" is a question the
 * editor should be able to answer without opening a diff.
 */
import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";

/** Re-read the baseline (dispatch after a save, when "what's on disk" has moved). */
export const refreshChangeBars = StateEffect.define<null>();

type HunkKind = "add" | "mod" | "del";

interface Hunk {
  kind: HunkKind;
  /** Line range in the CURRENT document, 1-based and inclusive. Empty for a deletion. */
  from: number;
  to: number;
  /** The baseline lines this block replaced, for reverting. */
  old: string[];
}

/**
 * Line diff, patience-style: trim the common ends, then split what is left on lines that
 * occur exactly once on each side and recurse between them.
 *
 * A full LCS would be quadratic on a big file for a gutter nobody asked to be exact; this
 * gets the same answer on real edits (which are local) at a fraction of the cost, and
 * degrades to "one big modified block" rather than to something wrong.
 */
export function diffLines(oldLines: string[], curLines: string[]): Hunk[] {
  const out: Hunk[] = [];

  const walk = (oa: number, ob: number, ca: number, cb: number, depth: number) => {
    // Common prefix / suffix.
    while (oa < ob && ca < cb && oldLines[oa] === curLines[ca]) {
      oa++;
      ca++;
    }
    while (oa < ob && ca < cb && oldLines[ob - 1] === curLines[cb - 1]) {
      ob--;
      cb--;
    }
    if (oa === ob && ca === cb) return;
    if (oa === ob) {
      out.push({ kind: "add", from: ca + 1, to: cb, old: [] });
      return;
    }
    if (ca === cb) {
      // A pure deletion has no line of its own; it is drawn against the line that now
      // sits where the removed block used to be.
      out.push({ kind: "del", from: ca + 1, to: ca, old: oldLines.slice(oa, ob) });
      return;
    }
    if (depth > 12) {
      out.push({ kind: "mod", from: ca + 1, to: cb, old: oldLines.slice(oa, ob) });
      return;
    }

    // Lines that appear exactly once on each side are safe anchors to split on.
    const countIn = (lines: string[], from: number, to: number) => {
      const seen = new Map<string, number>();
      for (let i = from; i < to; i++) seen.set(lines[i], (seen.get(lines[i]) ?? 0) + 1);
      return seen;
    };
    const oldCount = countIn(oldLines, oa, ob);
    const curCount = countIn(curLines, ca, cb);
    let bestOld = -1;
    let bestCur = -1;
    for (let i = ca; i < cb; i++) {
      const line = curLines[i];
      if (!line.trim()) continue; // blank lines anchor nothing
      if (curCount.get(line) !== 1 || oldCount.get(line) !== 1) continue;
      bestCur = i;
      bestOld = oldLines.indexOf(line, oa);
      break;
    }
    if (bestCur < 0 || bestOld < 0) {
      out.push({ kind: "mod", from: ca + 1, to: cb, old: oldLines.slice(oa, ob) });
      return;
    }
    walk(oa, bestOld, ca, bestCur, depth + 1);
    walk(bestOld + 1, ob, bestCur + 1, cb, depth + 1);
  };

  walk(0, oldLines.length, 0, curLines.length, 0);
  // Recursion emits the left half first, but only within a branch; sort so the gutter's
  // RangeSetBuilder gets its markers in document order.
  return out.sort((a, b) => a.from - b.from);
}

class BarMarker extends GutterMarker {
  constructor(readonly kind: HunkKind) {
    super();
  }

  eq(other: BarMarker) {
    return other.kind === this.kind;
  }

  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-change-bar cm-change-${this.kind}`;
    el.title =
      this.kind === "add"
        ? "Added since the last save — click to revert"
        : this.kind === "del"
          ? "Lines deleted here — click to restore"
          : "Modified since the last save — click to revert";
    return el;
  }
}

interface Bars {
  hunks: Hunk[];
  markers: ReturnType<RangeSetBuilder<GutterMarker>["finish"]>;
}

function build(doc: { line: (n: number) => { from: number }; lines: number }, hunks: Hunk[]): Bars {
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const h of hunks) {
    if (h.kind === "del") {
      const line = Math.min(Math.max(1, h.from), doc.lines);
      builder.add(doc.line(line).from, doc.line(line).from, new BarMarker("del"));
      continue;
    }
    for (let n = h.from; n <= h.to && n <= doc.lines; n++) {
      builder.add(doc.line(n).from, doc.line(n).from, new BarMarker(h.kind));
    }
  }
  return { hunks, markers: builder.finish() };
}

/**
 * The change-bar gutter for a buffer. `baseline` is asked for the file's on-disk text
 * (it changes on every save, which is why it is a function and not a string).
 */
export function changeBars(baseline: () => string): Extension[] {
  const compute = (state: any): Bars =>
    build(
      state.doc,
      diffLines(baseline().split("\n"), state.doc.toString().split("\n")),
    );

  const field = StateField.define<Bars>({
    create: (state) => compute(state),
    update: (value, tr) =>
      tr.docChanged || tr.effects.some((e) => e.is(refreshChangeBars))
        ? compute(tr.state)
        : value,
  });

  return [
    field,
    gutter({
      class: "cm-changebar-gutter",
      markers: (view) => view.state.field(field).markers,
      // Reserve the column always, so the first edit doesn't shift the document sideways.
      initialSpacer: () => new BarMarker("mod"),
      domEventHandlers: {
        click: (view, block) => {
          const line = view.state.doc.lineAt(block.from).number;
          const hunk = view.state
            .field(field)
            .hunks.find((h) => (h.kind === "del" ? h.from === line : line >= h.from && line <= h.to));
          if (!hunk) return false;
          revert(view, hunk);
          return true;
        },
      },
    }),
    EditorView.theme({
      ".cm-changebar-gutter": { width: "4px", padding: "0", cursor: "pointer" },
      ".cm-change-bar": { width: "3px", height: "100%", marginLeft: "1px", borderRadius: "1px" },
      // Green for new lines, blue for edited ones — IntelliJ's own coding.
      ".cm-change-add": { background: "#59a869" },
      ".cm-change-mod": { background: "#3574f0" },
      // A deletion has no line to colour, so it is drawn as a wedge between two lines.
      ".cm-change-del": {
        width: "0",
        height: "0",
        marginLeft: "0",
        borderLeft: "4px solid #9da0a8",
        borderTop: "3px solid transparent",
        borderBottom: "3px solid transparent",
      },
    }),
  ];
}

/** Put one changed block back to what is on disk. */
function revert(view: EditorView, hunk: Hunk) {
  const doc = view.state.doc;
  const text = hunk.old.join("\n");
  if (hunk.kind === "del") {
    // The removed lines go back above the line the wedge sits on (or at the very end).
    const at = hunk.from <= doc.lines ? doc.line(hunk.from).from : doc.length;
    view.dispatch({
      changes: { from: at, insert: hunk.from <= doc.lines ? `${text}\n` : `\n${text}` },
      userEvent: "revert.line",
    });
    return;
  }
  const from = doc.line(Math.min(hunk.from, doc.lines)).from;
  const to = doc.line(Math.min(hunk.to, doc.lines)).to;
  if (hunk.kind === "add" && !hunk.old.length) {
    /*
      Removing lines means removing a newline with them, and WHICH newline depends on
      where the block sits. Mid-file it is the one after the block (so the following
      line moves up); at the end of the file there is no newline after it, so the one
      BEFORE it has to go — taking `to` alone left an empty last line behind, which
      kept the file dirty and put a change bar on the blank it had just created.
    */
    if (hunk.to >= doc.lines) {
      const start = hunk.from > 1 ? doc.line(hunk.from - 1).to : 0;
      view.dispatch({ changes: { from: start, to: doc.length }, userEvent: "revert.line" });
      return;
    }
    view.dispatch(
      { changes: { from, to: doc.line(hunk.to + 1).from }, userEvent: "revert.line" },
    );
    return;
  }
  view.dispatch({ changes: { from, to, insert: text }, userEvent: "revert.line" });
}
