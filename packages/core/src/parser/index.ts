import type { Language, ParsedFile } from "../types.js";
import { parseDart } from "./dart.js";
import { parseTypeScript } from "./typescript.js";

export { parseTypeScript } from "./typescript.js";
export { parseDart } from "./dart.js";

/**
 * Detect a file's language from its extension. Returns `null` for files
 * we don't know how to parse.
 */
export function detectLanguage(path: string): Language | null {
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return "javascript";
  }
  if (lower.endsWith(".dart")) return "dart";
  return null;
}

/**
 * Parse a single source file. The caller is responsible for choosing the
 * language; if you don't know, use `detectLanguage` first.
 */
export function parseFile(
  path: string,
  source: string,
  language: Language,
): ParsedFile {
  switch (language) {
    case "typescript":
      return parseTypeScript(path, source, "typescript");
    case "javascript":
      return parseTypeScript(path, source, "javascript");
    case "dart":
      return parseDart(path, source);
  }
}
