/**
 * CodeMirror wiring for the built-in editor: the dark theme (matched to the app's CSS
 * tokens) and lazy per-language loading.
 *
 * Language modes are imported dynamically so a session that only ever opens Markdown
 * never pays for the Rust or Java parsers.
 */
import { EditorView } from "@codemirror/view";
import {
  HighlightStyle,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
} from "@codemirror/language";
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
    /*
      Selection. The focused case needs the base theme's own selector shape
      (`&dark.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`) —
      a shorter one loses on specificity and CodeMirror paints its default near-black
      `#233`, which is what made a double-clicked word look unselected.
    */
    ".cm-selectionBackground, .cm-content ::selection": { background: "#214283 !important" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
      background: "#214283 !important",
    },
    ".cm-gutters": {
      backgroundColor: "#131416",
      color: "#4b5059",
      border: "none",
      // No rule between gutter and text, like the IDE — the line numbers' own left
      // margin is the separation.
      borderRight: "1px solid #131416",
    },
    /*
      Translucent, not the opaque `#1c1d20` it looks like: `drawSelection` paints the
      selection in a layer BEHIND the lines, so an opaque active line hides the selection
      on the very line the cursor is on. 4% white over `#131416` lands on the same colour.
    */
    ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.04)" },
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
  // KDoc/JavaDoc is a comment the IDE treats as documentation, and tints accordingly.
  { tag: [t.docComment, t.docString], color: "#5f826b" },
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "#cf8e6d" },
  { tag: [t.self, t.moduleKeyword, t.definitionKeyword], color: "#cf8e6d" },
  // `true` / `false` / `null` are keywords in the IDE's scheme, not literals.
  { tag: [t.bool, t.null], color: "#cf8e6d" },
  { tag: [t.string, t.special(t.string)], color: "#6aab73" },
  { tag: [t.regexp, t.escape], color: "#2aacb8" },
  { tag: [t.number, t.integer, t.float, t.unit], color: "#2aacb8" },
  // Stream modes report `true` / `false` / `None` as atoms; the IDE paints them keywords.
  { tag: [t.atom], color: "#cf8e6d" },
  // A declaration is blue, a call is left plain — the IDE's way of making the place a
  // thing is DEFINED stand out from the many places it is used.
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.function(t.definition(t.variableName)),
      t.definition(t.function(t.variableName)),
    ],
    color: "#56a8f5",
  },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "#bcbec4" },
  // Fields and members: the violet that makes `logger.info(…)` read as state, not noise.
  { tag: [t.propertyName, t.attributeName], color: "#c77dbb" },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: "#c77dbb" },
  { tag: [t.special(t.variableName)], color: "#c77dbb", fontStyle: "italic" },
  { tag: [t.labelName], color: "#b389c5" },
  { tag: [t.annotation, t.meta, t.processingInstruction], color: "#b3ae60" },
  { tag: [t.typeName, t.className, t.namespace], color: "#bcbec4" },
  { tag: [t.definition(t.typeName), t.definition(t.className)], color: "#bcbec4" },
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
 * Colour what follows a `.` as a member.
 *
 * The CodeMirror 5 modes below report every identifier as a plain variable, which leaves
 * `logger.info(…)`, `candidates.size` and `Filter.eq(…)` in the same flat grey as the
 * punctuation around them — the single biggest reason these files read as colourless next
 * to the IDE. Looking at the character before the token is enough to tell a member from a
 * bare identifier, and costs one string index per token.
 */
function memberAware(base: StreamParser<unknown>): StreamParser<unknown> {
  return {
    ...base,
    tokenTable: { ...(base.tokenTable ?? {}), csMember: t.propertyName },
    token(stream, state) {
      const from = stream.pos;
      const style = base.token(stream, state);
      if (!style || stream.pos === from) return style;
      // Only plain identifiers are re-labelled: a keyword or string after a dot is the
      // mode telling us something we have no business overriding.
      if (style !== "variable" && style !== "variableName") return style;
      return stream.string.charAt(from - 1) === "." ? "csMember" : style;
    },
  };
}

/** Wrap a CodeMirror 5 stream mode as a language the editor can load on demand. */
function stream(load: () => Promise<StreamParser<unknown>>): () => Promise<LanguageSupport> {
  return async () => new LanguageSupport(StreamLanguage.define(memberAware(await load())));
}

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
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  // Everything below is a CodeMirror 5 stream mode. They tokenise less finely than a
  // Lezer grammar, but "keywords, strings, numbers and comments in the right colours"
  // is most of what reading code needs — and it is what these file types had none of.
  kt: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin)),
  kts: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin)),
  scala: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala)),
  groovy: stream(() => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy)),
  gradle: stream(() => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy)),
  c: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c)),
  h: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c)),
  cpp: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp)),
  cc: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp)),
  hpp: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp)),
  cs: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp)),
  dart: stream(() => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart)),
  go: stream(() => import("@codemirror/legacy-modes/mode/go").then((m) => m.go)),
  swift: stream(() => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift)),
  rb: stream(() => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby)),
  lua: stream(() => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua)),
  sh: stream(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)),
  bash: stream(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)),
  zsh: stream(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell)),
  toml: stream(() => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml)),
  sql: stream(() => import("@codemirror/legacy-modes/mode/sql").then((m) => m.standardSQL)),
  xml: stream(() => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml)),
  properties: stream(() =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  ),
  ini: stream(() =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  ),
  env: stream(() =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  ),
  dockerfile: stream(() =>
    import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile),
  ),
};

/** Files recognised by NAME rather than extension. */
const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "sh",
  ".gitignore": "properties",
  ".env": "env",
  ".sdkmanrc": "properties",
  "gradle.properties": "properties",
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
