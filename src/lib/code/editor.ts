/**
 * CodeMirror wiring for the built-in editor: the dark theme (matched to the app's CSS
 * tokens) and lazy per-language loading.
 *
 * Language modes are imported dynamically so a session that only ever opens Markdown
 * never pays for the Rust or Java parsers.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * Editor chrome. Colours are literal because CodeMirror writes them into a stylesheet
 * it owns — the same reason `createTerminal` can't hand xterm `var(--…)`. Keep these in
 * step with the tokens in `src/app.css`.
 */
export const codesuTheme = EditorView.theme(
  {
    "&": { color: "#bcbec4", backgroundColor: "#131416", height: "100%" },
    ".cm-content": {
      caretColor: "#ced0d6",
      fontFamily:
        'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: "13px",
      padding: "8px 0 40vh 0",
    },
    ".cm-scroller": { lineHeight: "1.55", overflow: "auto" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#ced0d6", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#214283" },
    ".cm-gutters": {
      backgroundColor: "#131416",
      color: "#4b5059",
      border: "none",
      // No rule between gutter and text, like the IDE — the line numbers' own left
      // margin is the separation.
      borderRight: "1px solid #131416",
    },
    ".cm-activeLine": { backgroundColor: "#1c1d20" },
    // The Run gutter (see `testGutter`). Dim until hovered, so a file full of tests reads
    // as code rather than as a column of green arrows.
    ".cm-test-gutter": { width: "16px" },
    ".cm-test-run": {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      color: "#59a869",
      opacity: "0.62",
      cursor: "pointer",
    },
    ".cm-test-run:hover": { opacity: "1", transform: "scale(1.18)" },
    ".cm-activeLineGutter": { backgroundColor: "#1c1d20", color: "#a1a3ab" },
    ".cm-selectionMatch": { backgroundColor: "#3a4a5c" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "#3b514d",
      outline: "none",
    },
    ".cm-searchMatch": { backgroundColor: "#32593d" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#155a26" },
    ".cm-panels": { backgroundColor: "#1c1d20", color: "#dfe1e5", borderColor: "#2b2d31" },
    ".cm-panels input, .cm-panels button": {
      background: "#131416",
      color: "#dfe1e5",
      border: "1px solid #3c3f45",
      borderRadius: "5px",
      padding: "2px 6px",
    },
    ".cm-tooltip": {
      backgroundColor: "#212226",
      border: "1px solid #2b2d31",
      borderRadius: "7px",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#313338",
      border: "none",
      color: "#9da0a8",
      padding: "0 6px",
      borderRadius: "4px",
    },
  },
  { dark: true },
);

/**
 * Token colours, taken from IntelliJ IDEA's "New UI" dark scheme so a file reads the same
 * here as it does in the IDE next to it: keywords orange, strings green, numbers cyan,
 * declarations blue, fields violet, and plain identifiers left at the editor foreground
 * rather than tinted. Restraint is the point — the IDE colours what carries meaning and
 * leaves the rest alone.
 */
export const codesuHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#7a7e85" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "#cf8e6d" },
  { tag: [t.string, t.special(t.string)], color: "#6aab73" },
  { tag: [t.regexp, t.escape], color: "#2aacb8" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#2aacb8" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#56a8f5" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#bcbec4" },
  { tag: [t.propertyName, t.attributeName], color: "#c77dbb" },
  { tag: [t.annotation, t.meta], color: "#b3ae60" },
  { tag: [t.typeName, t.className, t.namespace], color: "#bcbec4" },
  { tag: [t.tagName], color: "#e8bf6a" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#bcbec4" },
  { tag: [t.variableName], color: "#bcbec4" },
  { tag: [t.heading], color: "#56a8f5", fontWeight: "700" },
  { tag: [t.link, t.url], color: "#548af7", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.invalid], color: "#f75464" },
]);

export const syntaxTheme = [codesuTheme, syntaxHighlighting(codesuHighlight)];

/**
 * The loader for each extension we have a parser for. A file whose type is missing here
 * still opens — it just gets no highlighting, which is far better than refusing it.
 */
const LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  js: async () => (await import("@codemirror/lang-javascript")).javascript(),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  mjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
  cjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
  ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  mts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  tsx: async () =>
    (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  jsonc: async () => (await import("@codemirror/lang-json")).json(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  scss: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  htm: async () => (await import("@codemirror/lang-html")).html(),
  // Svelte and Vue are HTML documents with script/style islands — the HTML mode gets the
  // markup, the scripts and the styles right, which is most of the file.
  svelte: async () => (await import("@codemirror/lang-html")).html(),
  vue: async () => (await import("@codemirror/lang-html")).html(),
  md: async () => (await import("@codemirror/lang-markdown")).markdown(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  rs: async () => (await import("@codemirror/lang-rust")).rust(),
  py: async () => (await import("@codemirror/lang-python")).python(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  // Kotlin has no parser here; Java's is close enough to colour keywords and strings.
  kt: async () => (await import("@codemirror/lang-java")).java(),
  kts: async () => (await import("@codemirror/lang-java")).java(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
};

/** Files recognised by NAME rather than extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: "yaml",
  makefile: "yaml",
  ".gitignore": "yaml",
  ".env": "yaml",
};

/** The language mode for `path`, or null when we have no parser for it. */
export async function languageFor(path: string): Promise<LanguageSupport | null> {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : (BY_NAME[name] ?? "");
  const load = LOADERS[ext] ?? (BY_NAME[name] ? LOADERS[BY_NAME[name]] : undefined);
  if (!load) return null;
  try {
    return await load();
  } catch {
    return null; // a mode that fails to load must never block opening the file
  }
}
