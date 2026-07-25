/**
 * Tiny, dependency-free Markdown support for Notes & Tasks.
 *   • renderMarkdown() — a minimal, SAFE block+inline renderer (input is HTML-escaped
 *     first and link schemes are allowlisted, so `{@html}` output can't inject tags,
 *     attributes or `javascript:` navigations — see the invariant on escapeHtml).
 *   • applyMdFormat() — pure textarea transform for the formatting toolbar.
 *   • stripMarkdown() — flatten to plain text for list snippets.
 *
 * Not a spec-complete parser — covers the common cases (headings, bold, italic,
 * code, lists, quotes, links, rules) which is what a notes/tasks tool needs.
 */

/**
 * SECURITY INVARIANT — do not weaken either half of this.
 *
 *   1. QUOTES ARE ESCAPED. The output of this module goes through `{@html}`, and the
 *      inline rules below drop captured text into a double-quoted `href` attribute.
 *      Escaping only `& < >` lets `[x]("/onmouseover="…)` close that attribute and
 *      add handlers of its own — and in a Tauri webview an injected handler can
 *      `invoke("start_pty", …)`, i.e. run arbitrary local programs. Tag-escaping alone
 *      is NOT enough; the quotes are what keep an attribute an attribute.
 *   2. HREF SCHEMES ARE ALLOWLISTED ({@link isSafeHref}). Escaping cannot stop
 *      `[x](javascript:alert(1))`, which needs no quotes at all.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Schemes an anchor may carry. Anything else is rendered as plain text, not a link. */
const SAFE_SCHEMES = ["http", "https", "mailto"];

/**
 * May this URL become an `href`? Called with ALREADY-ESCAPED text, which is why the
 * entities escapeHtml produces (`&amp; &lt; &gt; &quot; &#39;`) are deliberately left
 * alone: none of them decodes to a `:` or to a scheme letter, so none can conjure a
 * scheme that isn't visible here.
 *
 * A URL with no scheme at all (a relative path, `#anchor`, `?query`) is allowed — it
 * can only ever point back at the app itself.
 */
function isSafeHref(url: string): boolean {
  // Control characters are dropped by URL parsers before the scheme is read, so
  // "java\x01script:alert(1)" navigates as javascript: — strip them first.
  // eslint-disable-next-line no-control-regex
  const u = url.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  return !scheme || SAFE_SCHEMES.includes(scheme[1].toLowerCase());
}

/** Inline spans. Operates on already-escaped text. */
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_(?!\s)([^_\n]+?)_/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) =>
      isSafeHref(url)
        ? `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`
        : m, // unusable scheme: leave the source text, escaped, exactly as written
    );
}

/**
 * The blockquote marker as it looks *after* escapeHtml: `>` has already become
 * `&gt;` by the time any block rule runs, so matching a bare `>` here silently
 * never fires and quotes fall through to `<p>&gt; …</p>`.
 */
const QUOTE_MARKER = /^&gt;\s?/;

const BLOCK_START = /^(#{1,6}\s|&gt;\s?|```|\s*[-*+]\s|\s*\d+\.\s)/;

export function renderMarkdown(src: string): string {
  if (!src || !src.trim()) return "";
  const lines = escapeHtml(src).replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let code: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      if (!inCode) {
        closeList();
        inCode = true;
        code = [];
      } else {
        out.push(`<pre><code>${code.join("\n")}</code></pre>`);
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      code.push(line);
      i++;
      continue;
    }

    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList();
      out.push("<hr/>");
      i++;
      continue;
    }

    if (QUOTE_MARKER.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(QUOTE_MARKER, ""))}</blockquote>`);
      i++;
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++;
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }

    // Paragraph: gather consecutive plain lines, joined with <br/>.
    closeList();
    const para = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !BLOCK_START.test(lines[j]) && !/^```/.test(lines[j])) {
      para.push(lines[j]);
      j++;
    }
    out.push(`<p>${para.map(inline).join("<br/>")}</p>`);
    i = j;
  }
  if (inCode) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  closeList();
  return out.join("\n");
}

/** Flatten markdown to a one-line plain string (for list previews). */
export function stripMarkdown(src: string): string {
  return src
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_~>#]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export type MdAction = "bold" | "italic" | "code" | "h1" | "h2" | "ul" | "ol" | "quote" | "link";

/** Pure transform for the toolbar: returns the new value + selection to restore. */
export function applyMdFormat(
  value: string,
  selStart: number,
  selEnd: number,
  action: MdAction,
): { value: string; selStart: number; selEnd: number } {
  const before = value.slice(0, selStart);
  const sel = value.slice(selStart, selEnd);
  const after = value.slice(selEnd);

  const wrap = (mark: string, placeholder: string) => {
    const text = sel || placeholder;
    const s = before.length + mark.length;
    return { value: before + mark + text + mark + after, selStart: s, selEnd: s + text.length };
  };

  const linePrefix = (prefix: string) => {
    const lineStart = before.lastIndexOf("\n") + 1;
    const head = value.slice(0, lineStart);
    const block = value.slice(lineStart, selEnd);
    const rest = value.slice(selEnd);
    const prefixed = block.split("\n").map((l) => prefix + l).join("\n");
    return { value: head + prefixed + rest, selStart: lineStart, selEnd: lineStart + prefixed.length };
  };

  switch (action) {
    case "bold":
      return wrap("**", "bold text");
    case "italic":
      return wrap("*", "italic text");
    case "code":
      return wrap("`", "code");
    case "h1":
      return linePrefix("# ");
    case "h2":
      return linePrefix("## ");
    case "ul":
      return linePrefix("- ");
    case "ol":
      return linePrefix("1. ");
    case "quote":
      return linePrefix("> ");
    case "link": {
      const text = sel || "link";
      const url = "url";
      const s = before.length + 1 + text.length + 2;
      return { value: `${before}[${text}](${url})${after}`, selStart: s, selEnd: s + url.length };
    }
  }
}
