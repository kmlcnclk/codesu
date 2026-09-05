/**
 * The scope breadcrumb IntelliJ pins to the top of the editor: the `class …` and
 * `fun …` lines that the line you are looking at lives inside, kept on screen once
 * they have scrolled away.
 *
 * Derived from indentation rather than from the syntax tree, deliberately: every
 * language in the editor indents its blocks, not every language has a grammar loaded
 * (and the ones that do name their nodes differently), and a breadcrumb that quietly
 * works everywhere beats one that is exact in TypeScript and absent in Kotlin.
 */

export interface ScopeLine {
  /** 1-based line number in the document. */
  no: number;
  text: string;
}

/** Leading whitespace width, with tabs counted as four columns. */
function indentOf(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/**
 * Does this line open a block?
 *
 * Comments never do (a `/** …` above a function is not the function), and neither does a
 * line that closes what it opens on the same line.
 */
function opensScope(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(\/\/|\*|\/\*|#|<!--|-->)/.test(t)) return false;
  if (/[{([:]$/.test(t)) return true;
  return t.includes("{") && !t.includes("}");
}

/**
 * The line a construct STARTS on.
 *
 * A multi-line signature ends in `) {`, which is the line that opens the block but says
 * nothing about what the block is — `class OrdersRefundsService(`, two lines above it,
 * is the breadcrumb worth pinning. Continuation lines are indented further than the
 * line they continue, so the head is the first line back at the same indent.
 */
function headOf(lineText: (n: number) => string, n: number, indent: number): number {
  if (!/^[)\]}]/.test(lineText(n).trim())) return n;
  for (let k = n - 1; k >= 1; k--) {
    const text = lineText(k);
    if (!text.trim()) continue;
    if (indentOf(text) <= indent) return k;
  }
  return n;
}

/**
 * The chain of enclosing scope lines above `topLine`, outermost first.
 *
 * Walks upward keeping only lines that are indented LESS than everything seen so far —
 * that is what "encloses" means without a parser — and stops at column zero or once
 * `max` levels have been collected (a deeper breadcrumb costs more screen than the code
 * it is describing).
 */
export function scopeChain(
  lineText: (n: number) => string,
  topLine: number,
  max = 3,
): ScopeLine[] {
  if (topLine <= 1) return [];
  const out: ScopeLine[] = [];
  let indent = indentOf(lineText(topLine));
  // A blank or dedented first visible line would otherwise cut the walk short.
  for (let n = topLine; n >= 1 && !lineText(n).trim(); n--) indent = Number.MAX_SAFE_INTEGER;

  for (let n = topLine - 1; n >= 1; n--) {
    const text = lineText(n);
    if (!text.trim()) continue;
    const ind = indentOf(text);
    if (ind >= indent) continue;
    indent = ind;
    if (opensScope(text)) {
      const head = headOf(lineText, n, ind);
      out.unshift({ no: head, text: lineText(head) });
      if (out.length >= max) break;
    }
    if (ind === 0) break;
  }
  return out;
}
