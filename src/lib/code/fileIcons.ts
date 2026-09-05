/**
 * File-type badges for the tree, the tabs and anywhere else a filename is listed.
 *
 * IntelliJ gives every language its own icon, and that is what makes a long tree
 * scannable: you find the Kotlin file by its colour long before you have read the name.
 * A two-character monospace badge does the same job here without shipping an icon set —
 * the label is the extension's own shorthand, the colour is the language's.
 */

export interface FileBadge {
  /** One or two characters shown in the badge. */
  label: string;
  /** Badge foreground; the background is derived from it at 14% opacity. */
  color: string;
}

/** Palette anchors, matching the app's hue tokens so nothing new enters the theme. */
const BLUE = "#6ea8fe";
const VIOLET = "#b48ef7";
const AMBER = "#e8b04b";
const TEAL = "#4fc4c0";
const ROSE = "#f3809b";
const LIME = "#96c95f";
const CYAN = "#57bde0";
const GREY = "#8b9099";

const BY_EXT: Record<string, FileBadge> = {
  kt: { label: "KT", color: VIOLET },
  kts: { label: "KT", color: VIOLET },
  java: { label: "J", color: ROSE },
  ts: { label: "TS", color: BLUE },
  tsx: { label: "TX", color: BLUE },
  js: { label: "JS", color: AMBER },
  jsx: { label: "JX", color: AMBER },
  mjs: { label: "JS", color: AMBER },
  cjs: { label: "JS", color: AMBER },
  svelte: { label: "SV", color: "#ff6a3d" },
  vue: { label: "VU", color: LIME },
  rs: { label: "RS", color: "#dd9c6a" },
  go: { label: "GO", color: CYAN },
  py: { label: "PY", color: TEAL },
  rb: { label: "RB", color: ROSE },
  php: { label: "PH", color: VIOLET },
  swift: { label: "SW", color: "#ff7043" },
  c: { label: "C", color: BLUE },
  h: { label: "H", color: BLUE },
  cpp: { label: "C+", color: BLUE },
  cs: { label: "C#", color: VIOLET },
  sh: { label: "$", color: LIME },
  bash: { label: "$", color: LIME },
  zsh: { label: "$", color: LIME },
  sql: { label: "SQ", color: CYAN },
  md: { label: "M↓", color: BLUE },
  mdx: { label: "M↓", color: BLUE },
  txt: { label: "≡", color: GREY },
  json: { label: "{}", color: AMBER },
  yaml: { label: "Y", color: ROSE },
  yml: { label: "Y", color: ROSE },
  toml: { label: "T", color: AMBER },
  xml: { label: "<>", color: AMBER },
  html: { label: "<>", color: "#ff6a3d" },
  css: { label: "#", color: BLUE },
  scss: { label: "#", color: ROSE },
  csv: { label: "≡", color: LIME },
  lock: { label: "🔒", color: GREY },
  env: { label: "≡", color: AMBER },
  gitignore: { label: "⊘", color: GREY },
  png: { label: "▣", color: VIOLET },
  jpg: { label: "▣", color: VIOLET },
  jpeg: { label: "▣", color: VIOLET },
  gif: { label: "▣", color: VIOLET },
  svg: { label: "▣", color: AMBER },
  webp: { label: "▣", color: VIOLET },
  ico: { label: "▣", color: VIOLET },
  pdf: { label: "▤", color: ROSE },
  zip: { label: "▤", color: GREY },
};

/** Whole filenames worth calling out, checked before the extension. */
const BY_NAME: Record<string, FileBadge> = {
  "package.json": { label: "{}", color: LIME },
  "tsconfig.json": { label: "TS", color: BLUE },
  dockerfile: { label: "DK", color: BLUE },
  makefile: { label: "MK", color: AMBER },
  "cargo.toml": { label: "RS", color: "#dd9c6a" },
  "cargo.lock": { label: "RS", color: GREY },
  "claude.md": { label: "M↓", color: "#d97757" },
  license: { label: "§", color: GREY },
  ".gitignore": { label: "⊘", color: GREY },
};

const FALLBACK: FileBadge = { label: "≡", color: GREY };

/** The badge for a file NAME (not a path — pass the basename). */
export function fileBadge(name: string): FileBadge {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  // A dotfile (`.sdkmanrc`) has no extension to speak of; its whole name is the key.
  const ext = dot > 0 ? lower.slice(dot + 1) : lower.replace(/^\./, "");
  return BY_EXT[ext] ?? FALLBACK;
}
