/**
 * Finding the tests in an open buffer, so the editor can put a ▶ in the gutter next to
 * each one — the affordance an IntelliJ or VS Code user reaches for first.
 *
 * These are line scanners, not parsers. A test declaration is a one-line shape in every
 * language here (`@Test` above a `fun`, `#[test]` above an `fn`, `it("…")`, `def test_…`),
 * and a real parser would mean shipping a second grammar per language, running it on
 * every keystroke, and still failing on the half-typed file that is the normal state of a
 * buffer being edited. The cost of the shallow read is the occasional missed or spurious
 * arrow; clicking one only ever types a command into a shell you can see.
 *
 * What to RUN for a target is not decided here — `resolve_test_command` reads the build
 * tool off disk (see `src-tauri/src/testing.rs`).
 */

/** One test (or test class) found in a file. */
export interface TestTarget {
  /** 1-based line the ▶ marker sits on. */
  line: number;
  /** "class" runs the whole class / module / describe block; "method" runs one test. */
  kind: "class" | "method";
  /** Label for the tooltip and the Run panel. */
  name: string;
  /** Fully-qualified class (JVM) or the enclosing class / module / describe title. */
  className: string | null;
  /** The test function's own name. */
  method: string | null;
}

/** Extensions we can find tests in — the editor only mounts the gutter for these. */
const SUPPORTED = new Set([
  "kt", "kts", "java", "groovy", "scala",
  "rs", "py", "go",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

/** Whether `path` is a language whose tests we know how to spot. */
export function supportsTests(path: string): boolean {
  return SUPPORTED.has(extensionOf(path));
}

/** JUnit and friends — every annotation that marks a method as a test. */
const JVM_TEST_ANNOTATION =
  /^@(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;

/** Kotlin allows `fun \`a test with spaces\`()`; the backticks are not part of the name. */
function unquote(name: string): string {
  return name.startsWith("`") && name.endsWith("`") ? name.slice(1, -1) : name;
}

/**
 * Kotlin / Java / Groovy / Scala.
 *
 * A test is a method carrying `@Test`, so the scanner tracks "an annotation was seen" and
 * attaches it to the next declaration. Other annotations in between (`@Disabled`,
 * `@DisplayName("…")`) are passed over rather than clearing the flag, because stacked
 * annotations are the norm.
 */
function jvmTests(lines: string[], ext: string): TestTarget[] {
  const pkg = lines
    .find((l) => /^\s*package\s+[\w.]+/.test(l))
    ?.match(/^\s*package\s+([\w.]+)/)?.[1];

  const out: TestTarget[] = [];
  let annotated = false;
  /** The outermost class in the file — the one a "run the class" arrow belongs to. */
  let outer: { name: string; line: number } | null = null;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*")) return;

    if (JVM_TEST_ANNOTATION.test(line)) {
      annotated = true;
      return;
    }
    if (line.startsWith("@")) return; // @Disabled, @DisplayName, @Inject, …

    const cls = line.match(
      /^(?:(?:public|private|protected|internal|open|final|abstract|sealed|static|data|inner|annotation|value)\s+)*(?:class|object)\s+(`[^`]+`|[A-Za-z_]\w*)/,
    );
    if (cls) {
      if (!outer) outer = { name: unquote(cls[1]), line: i + 1 };
      annotated = false;
      return;
    }

    if (!annotated) return;

    // Kotlin: `fun name(`. Java/Groovy/Scala: the identifier immediately before the
    // parameter list (`public void name(`, `def name(`).
    const fn =
      line.match(/\bfun\s+(`[^`]+`|[A-Za-z_]\w*)/) ??
      (ext === "kt" || ext === "kts" ? null : line.match(/\b([A-Za-z_]\w*)\s*\(/));
    if (fn) {
      const method = unquote(fn[1]);
      const simple = outer?.name ?? null;
      out.push({
        line: i + 1,
        kind: "method",
        name: method,
        className: simple ? (pkg ? `${pkg}.${simple}` : simple) : null,
        method,
      });
      annotated = false;
    }
  });

  if (out.length && outer) {
    const o = outer as { name: string; line: number };
    out.push({
      line: o.line,
      kind: "class",
      name: o.name,
      className: pkg ? `${pkg}.${o.name}` : o.name,
      method: null,
    });
  }
  return out;
}

/** Rust — `#[test]` / `#[tokio::test]` above an `fn`, plus the enclosing `mod tests`. */
function rustTests(lines: string[]): TestTarget[] {
  const out: TestTarget[] = [];
  let annotated = false;
  let mod: { name: string; line: number } | null = null;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("//")) return;

    if (/^#\[(?:\w+::)*(?:test|tokio::test)\b/.test(line) || /^#\[test_case\b/.test(line)) {
      annotated = true;
      return;
    }
    if (line.startsWith("#[")) return; // #[should_panic], #[ignore], …

    const m = line.match(/^(?:pub\s+)?mod\s+([A-Za-z_]\w*)/);
    if (m && !mod && /test/i.test(m[1])) mod = { name: m[1], line: i + 1 };

    if (!annotated) return;
    const fn = line.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/);
    if (fn) {
      out.push({ line: i + 1, kind: "method", name: fn[1], className: null, method: fn[1] });
      annotated = false;
    }
  });

  if (out.length && mod) {
    const m = mod as { name: string; line: number };
    out.push({ line: m.line, kind: "class", name: m.name, className: m.name, method: null });
  }
  return out;
}

/**
 * Python — pytest's conventions: `test_*` functions and `Test*` classes.
 *
 * A function's enclosing class is tracked by indentation: any `test_*` indented past
 * column 0 belongs to the last class opened above it, which is how a pytest node id
 * (`file::Class::method`) is put together.
 */
function pythonTests(lines: string[]): TestTarget[] {
  const out: TestTarget[] = [];
  /**
   * The class body we are inside, if any. `collected` is pytest's own rule: only a
   * `Test*` class is collected, so a `test_…` method in any OTHER class is not a test and
   * gets no arrow (running it would just report "no tests ran").
   */
  let cls: { name: string; indent: number; collected: boolean } | null = null;

  lines.forEach((raw, i) => {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;

    const c = line.match(/^class\s+([A-Za-z_]\w*)/);
    if (c) {
      const collected = /^Test/.test(c[1]);
      cls = { name: c[1], indent, collected };
      if (collected) {
        out.push({ line: i + 1, kind: "class", name: c[1], className: c[1], method: null });
      }
      return;
    }
    if (cls && indent <= cls.indent) cls = null; // dedented back out of the class
    if (cls && !cls.collected) return;

    const f = line.match(/^(?:async\s+)?def\s+(test_\w*)/);
    if (f) {
      out.push({
        line: i + 1,
        kind: "method",
        name: f[1],
        className: cls?.name ?? null,
        method: f[1],
      });
    }
  });
  return out;
}

/** Go — `func TestXxx(t *testing.T)`, and benchmarks/fuzz targets, which run the same way. */
function goTests(lines: string[]): TestTarget[] {
  const out: TestTarget[] = [];
  lines.forEach((raw, i) => {
    const f = raw
      .trim()
      .match(/^func\s+((?:Test|Benchmark|Fuzz|Example)[A-Z_]\w*)\s*\(/);
    if (f) out.push({ line: i + 1, kind: "method", name: f[1], className: null, method: f[1] });
  });
  return out;
}

/**
 * JS / TS — `describe`, `it` and `test` blocks (including `.only`, `.skip`, `.each`).
 *
 * The title string IS the identity here: it's what `vitest -t` and `jest -t` filter on,
 * so a block whose name is computed rather than literal is skipped instead of guessed at.
 */
function jsTests(lines: string[]): TestTarget[] {
  const out: TestTarget[] = [];
  /** The innermost describe still open, tracked by indentation like the Python scanner. */
  let suite: { name: string; indent: number } | null = null;

  lines.forEach((raw, i) => {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*")) return;

    const m = line.match(
      /^(?:await\s+)?(describe|it|test|suite)(?:\.\w+)*(?:`[^`]*`)?\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/,
    );
    if (!m) return;
    const [, keyword, , title] = m;
    if (suite && indent <= suite.indent) suite = null;

    if (keyword === "describe" || keyword === "suite") {
      out.push({ line: i + 1, kind: "class", name: title, className: title, method: null });
      suite = { name: title, indent };
    } else {
      out.push({
        line: i + 1,
        kind: "method",
        name: title,
        className: suite?.name ?? null,
        method: title,
      });
    }
  });
  return out;
}

/**
 * Every test in `doc`, sorted by line — the order the gutter needs to build its markers.
 */
export function detectTests(path: string, doc: string): TestTarget[] {
  const ext = extensionOf(path);
  if (!SUPPORTED.has(ext)) return [];
  const lines = doc.split("\n");
  // A whole-file scan on every keystroke would be wasteful on a large file; the editor
  // debounces this (see `testGutter`), so the cap is only a floor under the worst case.
  if (lines.length > 20000) return [];

  let found: TestTarget[];
  switch (ext) {
    case "kt":
    case "kts":
    case "java":
    case "groovy":
    case "scala":
      found = jvmTests(lines, ext);
      break;
    case "rs":
      found = rustTests(lines);
      break;
    case "py":
      found = pythonTests(lines);
      break;
    case "go":
      found = goTests(lines);
      break;
    default:
      found = jsTests(lines);
  }
  return found.sort((a, b) => a.line - b.line);
}
