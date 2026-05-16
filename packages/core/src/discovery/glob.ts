/**
 * Minimal glob matcher. Supports:
 *   *        — any number of characters except `/`
 *   **       — any number of characters including `/`
 *   ?        — exactly one character except `/`
 *   {a,b,c}  — alternation
 *
 * Path separators are always `/`. Patterns and inputs should both be
 * normalised before calling.
 */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` or `**` at the end matches zero or more path segments.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        re += escapeRegexChar(ch);
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const alts = inner.split(",").map((p) => p.split("").map(escapeRegexChar).join(""));
      re += "(?:" + alts.join("|") + ")";
      i = close + 1;
      continue;
    }
    re += escapeRegexChar(ch);
    i++;
  }
  return new RegExp("^" + re + "$");
}

function escapeRegexChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
}

/** True if `path` matches any of `patterns`. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (globToRegex(p).test(path)) return true;
  }
  return false;
}
