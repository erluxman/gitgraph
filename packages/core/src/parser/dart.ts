import type {
  ExportedSymbol,
  ParsedFile,
  RawImport,
  SymbolKind,
} from "../types.js";

/**
 * Regex-based Dart/Flutter parser. No Dart SDK runs in the browser
 * context, so we strip comments and strings, then scan for top-level
 * declarations and directives.
 *
 * "Exported" in Dart = public, i.e. identifier does not start with `_`.
 * All top-level public functions, classes, mixins, enums, typedefs, and
 * variables are collected.
 *
 * Flutter extras: classes that extend `StatelessWidget`/`StatefulWidget`
 * (or their `Consumer`/`HookWidget` variants) get `kind = "widget"`,
 * and any `build()` method is added to the class's method list.
 */
export function parseDart(path: string, source: string): ParsedFile {
  // Two buffers: directives live at column 0 outside any string, so we
  // need strings preserved for them. Declarations should ignore both
  // comments and strings (a class declared inside a doc string is not real).
  const commentsStripped = stripCommentsAndStrings(source, { strings: false });
  const fullyStripped = stripCommentsAndStrings(source, { strings: true });

  return {
    path,
    language: "dart",
    exports: collectDartExports(source, fullyStripped),
    imports: collectDartImports(source, commentsStripped, fullyStripped),
  };
}

// --- imports ---

const DIRECTIVE_RE =
  /^[ \t]*(import|export|part(?:\s+of)?)\s+(['"])([^'"]+)\2/gm;

function collectDartImports(
  source: string,
  commentsStripped: string,
  fullyStripped: string,
): RawImport[] {
  const out: RawImport[] = [];
  for (const match of commentsStripped.matchAll(DIRECTIVE_RE)) {
    const lineStart = match.index ?? 0;
    // The directive keyword starts after any leading whitespace captured
    // by `^[ \t]*`. We need to test that position (not the whitespace) to
    // know if we're inside a string literal.
    const keywordOffset = lineStart + (match[0]!.length - match[0]!.trimStart().length);
    if (fullyStripped[keywordOffset] !== commentsStripped[keywordOffset]) continue;

    const directive = match[1]!;
    const specifier = match[3]!;
    out.push({
      kind: directiveKind(directive),
      specifier,
      line: lineNumberOf(source, keywordOffset),
    });
  }
  return out;
}

function directiveKind(directive: string): RawImport["kind"] {
  if (directive === "import") return "static";
  if (directive === "export") return "reexport";
  if (directive === "part") return "dart-part";
  // "part of"
  return "dart-part-of";
}

// --- declarations ---

// Top-level declarations:
//   class Foo / abstract class Foo / mixin Foo / enum Foo / extension Foo
//   typedef Foo = ...
//   Foo bar() { ... }   /  void bar() { ... }
//   final/const/var/late [Type] foo = ...;
const CLASS_RE =
  /^\s*(?:abstract\s+)?(?:base\s+|interface\s+|final\s+|sealed\s+)?(class|mixin|enum|extension)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z_][A-Za-z0-9_<>?,\s]*))?/gm;

const TYPEDEF_RE = /^\s*typedef\s+([A-Za-z_][A-Za-z0-9_]*)\b/gm;

// Top-level function: [type] name(...) { ... }
// Excludes things that look like statements inside a class by requiring
// start-of-line at column 0 in the stripped source.
const FUNCTION_RE =
  /^[ \t]*(?:[A-Za-z_][\w<>?,\s]*?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:async\s*\*?|sync\s*\*)?\s*[{=]/gm;

const VARIABLE_RE =
  /^[ \t]*(?:final|const|late\s+final|late|var)\s+(?:[A-Za-z_][\w<>?,\s]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=;]/gm;

const WIDGET_BASE_CLASSES = new Set([
  "StatelessWidget",
  "StatefulWidget",
  "HookWidget",
  "HookConsumerWidget",
  "ConsumerWidget",
  "InheritedWidget",
]);

function collectDartExports(source: string, stripped: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const seen = new Set<string>();

  // Classes / mixins / enums / extensions.
  for (const match of stripped.matchAll(CLASS_RE)) {
    const name = match[2]!;
    if (isPrivate(name)) continue;
    const extendsBase = (match[3] ?? "").trim().split(/[<\s]/)[0] ?? "";
    const kind: SymbolKind = WIDGET_BASE_CLASSES.has(extendsBase) ? "widget" : "class";
    const offset = match.index ?? 0;
    const methods =
      match[1] === "class" || match[1] === "mixin" || match[1] === "extension"
        ? collectClassMethods(stripped, offset)
        : [];
    out.push({
      kind,
      name,
      line: lineNumberOf(source, offset),
      methods,
    });
    seen.add(name);
  }

  for (const match of stripped.matchAll(TYPEDEF_RE)) {
    const name = match[1]!;
    if (isPrivate(name) || seen.has(name)) continue;
    out.push({
      kind: "variable",
      name,
      line: lineNumberOf(source, match.index ?? 0),
    });
    seen.add(name);
  }

  for (const match of stripped.matchAll(FUNCTION_RE)) {
    const name = match[1]!;
    if (isPrivate(name) || seen.has(name)) continue;
    if (DART_RESERVED.has(name)) continue;
    const offset = match.index ?? 0;
    // Only count top-level functions: zero-indented in stripped source.
    if (!isTopLevel(stripped, offset)) continue;
    out.push({
      kind: "function",
      name,
      line: lineNumberOf(source, offset),
    });
    seen.add(name);
  }

  for (const match of stripped.matchAll(VARIABLE_RE)) {
    const name = match[1]!;
    if (isPrivate(name) || seen.has(name)) continue;
    const offset = match.index ?? 0;
    if (!isTopLevel(stripped, offset)) continue;
    out.push({
      kind: "variable",
      name,
      line: lineNumberOf(source, offset),
    });
    seen.add(name);
  }

  return out;
}

const DART_RESERVED = new Set([
  "if", "for", "while", "switch", "return", "throw", "try", "catch",
  "do", "else", "assert", "new", "await", "yield",
]);

function isPrivate(name: string): boolean {
  return name.startsWith("_");
}

function isTopLevel(stripped: string, offset: number): boolean {
  // Top-level = not inside any `{ ... }` block at this position.
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    const ch = stripped[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth === 0;
}

/** Find method names inside the class body starting at `classOffset`. */
function collectClassMethods(stripped: string, classOffset: number): readonly string[] {
  const openBrace = stripped.indexOf("{", classOffset);
  if (openBrace === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = stripped.slice(openBrace + 1, end);
  const methods: string[] = [];
  const seen = new Set<string>();
  // Match methods at the immediate class scope (depth 1 inside the body, i.e. depth 0 inside `body`).
  // Use the same heuristic: at top of `body`, before any nested brace.
  const methodRe =
    /(?:^|\n)\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:static\s+|external\s+|@override\s+)*([A-Za-z_][\w<>?,\s]*?)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = methodRe.exec(body)) !== null) {
    const candidate = m[2]!;
    if (DART_RESERVED.has(candidate)) continue;
    // Skip if it's a constructor (same name as class) — we don't have class name here,
    // but we filter duplicates and known non-methods below.
    if (seen.has(candidate)) continue;
    // Crude depth check inside body.
    const offsetInBody = m.index;
    let bDepth = 0;
    for (let i = 0; i < offsetInBody; i++) {
      const ch = body[i];
      if (ch === "{") bDepth++;
      else if (ch === "}") bDepth--;
    }
    if (bDepth !== 0) continue;
    methods.push(candidate);
    seen.add(candidate);
  }
  return methods;
}

// --- comment/string stripping ---

/**
 * Replace comments and string literals with spaces so positions/lines
 * stay aligned but regex matches don't fire inside them.
 *
 * Handles:
 *   - line comments  //...
 *   - block comments /* ... *\/   (with nesting, per Dart)
 *   - single-quoted strings, double-quoted strings, both with optional `r` prefix
 *   - triple-quoted strings ''' ... ''' and """ ... """
 *
 * Escape sequences inside strings are honoured.
 */
function stripCommentsAndStrings(
  source: string,
  opts: { readonly strings: boolean } = { strings: true },
): string {
  const out = source.split("");
  const len = source.length;
  let i = 0;
  while (i < len) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Line comment.
    if (ch === "/" && next === "/") {
      while (i < len && source[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    // Block comment (Dart allows nesting).
    if (ch === "/" && next === "*") {
      let depth = 1;
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      while (i < len && depth > 0) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth++;
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
        } else if (source[i] === "*" && source[i + 1] === "/") {
          depth--;
          out[i] = " ";
          out[i + 1] = " ";
          i += 2;
        } else {
          if (source[i] !== "\n") out[i] = " ";
          i++;
        }
      }
      continue;
    }

    // String literal (with optional raw `r` prefix).
    if (
      opts.strings &&
      (ch === "'" || ch === '"' || (ch === "r" && (next === "'" || next === '"')))
    ) {
      const rawOffset = ch === "r" ? 1 : 0;
      const quote = source[i + rawOffset]!;
      // Triple-quoted?
      const isTriple =
        source[i + rawOffset + 1] === quote && source[i + rawOffset + 2] === quote;
      const startQuoteLen = isTriple ? 3 : 1;
      const totalStart = rawOffset + startQuoteLen;
      // Blank out the opening quote.
      for (let k = 0; k < totalStart; k++) out[i + k] = " ";
      i += totalStart;
      const isRaw = rawOffset === 1;
      // Walk until matching close.
      while (i < len) {
        if (isTriple) {
          if (
            source[i] === quote &&
            source[i + 1] === quote &&
            source[i + 2] === quote
          ) {
            out[i] = out[i + 1] = out[i + 2] = " ";
            i += 3;
            break;
          }
        } else if (source[i] === quote) {
          out[i] = " ";
          i++;
          break;
        }
        if (!isRaw && source[i] === "\\" && i + 1 < len) {
          if (source[i] !== "\n") out[i] = " ";
          if (source[i + 1] !== "\n") out[i + 1] = " ";
          i += 2;
          continue;
        }
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      continue;
    }

    i++;
  }
  return out.join("");
}

function lineNumberOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}
