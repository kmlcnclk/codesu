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
    "&": { color: "#e9eef6", backgroundColor: "#0a0c11", height: "100%" },
    ".cm-content": {
      caretColor: "#6e8bff",
      fontFamily:
        'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: "13px",
      padding: "8px 0 40vh 0",
    },
    ".cm-scroller": { lineHeight: "1.55", overflow: "auto" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#6e8bff", borderLeftWidth: "2px" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#2b3566" },
    ".cm-gutters": {
      backgroundColor: "#0a0c11",
      color: "#3f4859",
      border: "none",
      borderRight: "1px solid #141a24",
    },
    ".cm-activeLine": { backgroundColor: "rgba(110, 139, 255, 0.055)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#7c8799" },
    ".cm-selectionMatch": { backgroundColor: "rgba(110, 139, 255, 0.18)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(110, 139, 255, 0.22)",
      outline: "none",
    },
    ".cm-searchMatch": { backgroundColor: "rgba(227, 179, 65, 0.28)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(227, 179, 65, 0.5)" },
    ".cm-panels": { backgroundColor: "#11151e", color: "#b0bccc", borderColor: "#1b2230" },
    ".cm-panels input, .cm-panels button": {
      background: "#161b26",
      color: "#e9eef6",
      border: "1px solid #29313f",
      borderRadius: "5px",
      padding: "2px 6px",
    },
    ".cm-tooltip": {
      backgroundColor: "#141a27",
      border: "1px solid #29313f",
      borderRadius: "7px",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#1d2431",
      border: "none",
      color: "#7c8799",
      padding: "0 6px",
      borderRadius: "4px",
    },
  },
  { dark: true },
);

/** Token colours — one hue family per role so the palette stays legible, not festive. */
export const codesuHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#566072", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "#c07af7" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#7fd88f" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#f0883e" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8aa1ff" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#e9eef6" },
  { tag: [t.propertyName, t.attributeName], color: "#39c5cf" },
  { tag: [t.typeName, t.className, t.namespace], color: "#e3b341" },
  { tag: [t.tagName], color: "#ff7b72" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#8b98a9" },
  { tag: [t.variableName], color: "#e9eef6" },
  { tag: [t.heading], color: "#8aa1ff", fontWeight: "700" },
  { tag: [t.link, t.url], color: "#39c5cf", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.invalid], color: "#ff6b6b" },
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
