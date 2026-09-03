/**
 * The Run gutter: a clickable ▶ beside every test in the open file, plus ⌘⇧R to run the
 * one under the cursor — the two ways an IDE offers to run a single test.
 *
 * Markers live in a `StateField` rather than being recomputed by the gutter on demand, so
 * a scan happens once per document change instead of once per redraw, and the arrows stay
 * put while scrolling. Clicking never runs anything itself: the target goes to the
 * `onRun` callback, which resolves it to a command and types it into the Run panel's
 * shell, where the user can see and interrupt it.
 */
import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { keymap } from "@codemirror/view";
import { RangeSetBuilder, StateField, type Extension, type RangeSet } from "@codemirror/state";
import { detectTests, supportsTests, type TestTarget } from "./tests";

/** ▶ for one test, ▶▶ for a whole class — the same visual distinction IntelliJ makes. */
const ARROW =
  '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M3 1.6 L10 6 L3 10.4 Z" fill="currentColor"/></svg>';
const DOUBLE_ARROW =
  '<svg viewBox="0 0 14 12" width="12" height="11" aria-hidden="true"><path d="M1.5 1.6 L7 6 L1.5 10.4 Z" fill="currentColor"/><path d="M7 1.6 L12.5 6 L7 10.4 Z" fill="currentColor"/></svg>';

class RunMarker extends GutterMarker {
  constructor(readonly target: TestTarget) {
    super();
  }

  /** Two markers are the same when they'd render and run identically. */
  eq(other: RunMarker) {
    return (
      other.target.kind === this.target.kind &&
      other.target.name === this.target.name &&
      other.target.className === this.target.className
    );
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-test-run";
    el.innerHTML = this.target.kind === "class" ? DOUBLE_ARROW : ARROW;
    el.title =
      this.target.kind === "class"
        ? `Run all tests in ${this.target.name}`
        : `Run ${this.target.name}`;
    return el;
  }
}

interface Tests {
  targets: TestTarget[];
  markers: RangeSet<GutterMarker>;
}

function scan(path: string, doc: string, lineAt: (n: number) => number, lines: number): Tests {
  const targets = detectTests(path, doc).filter((t) => t.line >= 1 && t.line <= lines);
  const builder = new RangeSetBuilder<GutterMarker>();
  // `detectTests` sorts by line, which is what RangeSetBuilder requires. Two targets can
  // still share a line (a one-line `it(…)` nested in a `describe(…)`); the first wins.
  let previous = -1;
  for (const t of targets) {
    if (t.line === previous) continue;
    previous = t.line;
    const from = lineAt(t.line);
    builder.add(from, from, new RunMarker(t));
  }
  return { targets, markers: builder.finish() };
}

/**
 * The gutter for `path`. `onRun` is handed the test that was clicked.
 *
 * Returns nothing for a language we can't find tests in, so a plain file gets no extra
 * gutter column at all.
 */
export function testGutter(path: string, onRun: (target: TestTarget) => void): Extension[] {
  if (!supportsTests(path)) return [];

  const field = StateField.define<Tests>({
    create: (state) =>
      scan(path, state.doc.toString(), (n) => state.doc.line(n).from, state.doc.lines),
    update: (value, tr) =>
      tr.docChanged
        ? scan(
            path,
            tr.state.doc.toString(),
            (n) => tr.state.doc.line(n).from,
            tr.state.doc.lines,
          )
        : value,
  });

  /** The test a line number belongs to, if any. */
  const at = (view: EditorView, line: number): TestTarget | null =>
    view.state.field(field).targets.find((t) => t.line === line) ?? null;

  return [
    field,
    gutter({
      class: "cm-test-gutter",
      markers: (view) => view.state.field(field).markers,
      // Reserve the column even on a line with no test, so adding one doesn't shift the
      // whole document sideways.
      initialSpacer: () => new RunMarker({ line: 1, kind: "method", name: "", className: null, method: null }),
      domEventHandlers: {
        click: (view, block) => {
          const target = at(view, view.state.doc.lineAt(block.from).number);
          if (!target) return false;
          onRun(target);
          return true;
        },
      },
    }),
    keymap.of([
      {
        key: "Mod-Shift-r",
        preventDefault: true,
        run: (view) => {
          const cursor = view.state.doc.lineAt(view.state.selection.main.head).number;
          const { targets } = view.state.field(field);
          // The test the cursor is IN, which is the nearest one declared at or above it —
          // the cursor is almost never on the `@Test` line itself.
          const target = [...targets]
            .reverse()
            .find((t) => t.line <= cursor && t.kind === "method")
            ?? targets.find((t) => t.kind === "class");
          if (!target) return false;
          onRun(target);
          return true;
        },
      },
    ]),
  ];
}
