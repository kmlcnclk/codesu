/**
 * Syntax highlighting for the diff viewer.
 *
 * The editor gets its colours from CodeMirror, which owns a live document. A diff is
 * just strings, so it parses the text with the same Lezer grammars and emits its own
 * markup. Without this a diff is one flat monospace colour with a green or red wash over
 * it — which is exactly as hard to read as it sounds, and worst in a new file, where
 * every single line is an addition.
 *
 * Class names are ours (`tok-*`, styled in DiffView) rather than CodeMirror's generated
 * ones: those only exist in the document while an editor using that HighlightStyle is
 * mounted, which is not a thing a diff can rely on.
 */
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import { languageFor } from "./editor";

/** Mirrors the editor's `codesuHighlight` roles, one CSS class per token family. */
const diffHighlighter = tagHighlighter([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], class: "tok-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "tok-number" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tok-fn" },
  { tag: [t.propertyName, t.attributeName], class: "tok-prop" },
  { tag: [t.typeName, t.className, t.namespace], class: "tok-type" },
  { tag: [t.tagName], class: "tok-tag" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], class: "tok-punct" },
  { tag: [t.heading], class: "tok-heading" },
  { tag: [t.link, t.url], class: "tok-link" },
  { tag: [t.invalid], class: "tok-invalid" },
]);

/**
 * Past this many characters the grammar is skipped and the lines come back unhighlighted.
 * Lezer parses synchronously here (there is no editor to yield to), so a very large diff
 * would otherwise freeze the window while it worked.
 */
const MAX_PARSE_CHARS = 400_000;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlight `lines` as one document in the language implied by `path`.
 *
 * Returns one HTML string per input line, or null when there is no grammar for the file
 * (or the text is too big) — callers then render the raw text, which is what the diff did
 * before and is a perfectly fine fallback.
 *
 * The lines are parsed TOGETHER, not one at a time: a grammar needs the surrounding
 * context to know that a line closes a block comment, or that a brace closes a block. A diff of
 * a hunk in the middle of a file is not valid standalone source, so some tokens near the
 * edges will be guessed wrong — vastly better than colouring nothing.
 */
export async function highlightLines(path: string, lines: string[]): Promise<string[] | null> {
  const support = await languageFor(path);
  if (!support) return null;

  const doc = lines.join("\n");
  if (!doc || doc.length > MAX_PARSE_CHARS) return null;

  let tree;
  try {
    tree = support.language.parser.parse(doc);
  } catch {
    return null; // a grammar that chokes must never take the diff down with it
  }

  // Lezer emits ranges in document order and never overlapping, which is what lets the
  // per-line walk below keep a single cursor into the list.
  const tokens: { from: number; to: number; cls: string }[] = [];
  try {
    highlightTree(tree, diffHighlighter, (from, to, cls) => tokens.push({ from, to, cls }));
  } catch {
    return null;
  }

  const out: string[] = [];
  let lineStart = 0;
  let cursor = 0;

  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    let pos = lineStart;
    let html = "";

    // Drop tokens that ended before this line began.
    while (cursor < tokens.length && tokens[cursor].to <= lineStart) cursor++;

    let i = cursor;
    while (i < tokens.length && tokens[i].from < lineEnd) {
      const tk = tokens[i];
      const from = Math.max(tk.from, lineStart);
      const to = Math.min(tk.to, lineEnd);
      if (from > pos) html += escapeHtml(doc.slice(pos, from));
      if (to > from) html += `<span class="${tk.cls}">${escapeHtml(doc.slice(from, to))}</span>`;
      pos = to;
      // A token spanning into the next line (a block comment, a template string) must
      // stay under the cursor so the next line can pick up its remainder.
      if (tk.to > lineEnd) break;
      i++;
    }
    cursor = i;

    if (pos < lineEnd) html += escapeHtml(doc.slice(pos, lineEnd));
    out.push(html);
    lineStart = lineEnd + 1; // +1 for the "\n" the join added
  }

  return out;
}
