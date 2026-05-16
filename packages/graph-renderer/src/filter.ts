import type { ParsedFile } from "@gitgraph/core";
import type { SceneNode } from "./types.js";

/**
 * Result of applying a filter to a scene: a set of matched node ids.
 * Non-matched nodes should be visually dimmed by the renderer rather than
 * hidden — keeping them in place preserves spatial memory.
 */
export type FilterResult = ReadonlySet<string>;

/**
 * "No filter active" sentinel. The renderer should special-case this and
 * skip dimming everything.
 */
export const ALL_MATCHED: unique symbol = Symbol("all-matched");
export type FilterResultOrAll = FilterResult | typeof ALL_MATCHED;

export interface FilterContext {
  readonly nodes: readonly SceneNode[];
  readonly filesByPath: ReadonlyMap<string, ParsedFile>;
  /** For "files that import X" queries. */
  readonly incoming: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Parse a single filter query string into a structured filter.
 *
 * Supported syntax:
 *   plain text          — fuzzy match on filename or export name
 *   folder:src/auth     — only files whose folder starts with `src/auth`
 *   imports:src/auth.ts — only files that import (directly or transitively) `src/auth.ts`
 *   risk:>0.5           — only files with risk score above threshold
 *   core:true / core:false
 */
export type Filter =
  | { kind: "text"; query: string }
  | { kind: "folder"; prefix: string }
  | { kind: "imports"; target: string }
  | { kind: "risk"; op: ">" | "<" | ">=" | "<=" | "="; value: number }
  | { kind: "core"; value: boolean };

export function parseFilter(input: string): Filter | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("folder:")) {
    return { kind: "folder", prefix: trimmed.slice("folder:".length) };
  }
  if (trimmed.startsWith("imports:")) {
    return { kind: "imports", target: trimmed.slice("imports:".length) };
  }
  if (trimmed.startsWith("core:")) {
    const v = trimmed.slice("core:".length).toLowerCase();
    return { kind: "core", value: v === "true" || v === "yes" || v === "1" };
  }
  if (trimmed.startsWith("risk:")) {
    const expr = trimmed.slice("risk:".length).trim();
    const match = expr.match(/^(>=|<=|>|<|=)(.+)$/);
    if (match) {
      const value = Number(match[2]);
      if (!Number.isNaN(value)) {
        return { kind: "risk", op: match[1] as Filter["op" & keyof Filter], value };
      }
    }
    return null;
  }
  return { kind: "text", query: trimmed.toLowerCase() };
}

export function applyFilter(filter: Filter, ctx: FilterContext): FilterResult {
  switch (filter.kind) {
    case "text":
      return matchText(filter.query, ctx);
    case "folder":
      return matchFolder(filter.prefix, ctx);
    case "imports":
      return matchImporters(filter.target, ctx);
    case "risk":
      return matchRisk(filter.op, filter.value, ctx);
    case "core":
      return matchCore(filter.value, ctx);
  }
}

function matchText(query: string, ctx: FilterContext): FilterResult {
  const out = new Set<string>();
  for (const node of ctx.nodes) {
    if (node.displayName.toLowerCase().includes(query)) {
      out.add(node.id);
      continue;
    }
    if (node.path.toLowerCase().includes(query)) {
      out.add(node.id);
      continue;
    }
    const file = ctx.filesByPath.get(node.path);
    if (file === undefined) continue;
    for (const exp of file.exports) {
      if (exp.name.toLowerCase().includes(query)) {
        out.add(node.id);
        break;
      }
    }
  }
  return out;
}

function matchFolder(prefix: string, ctx: FilterContext): FilterResult {
  const normalised = prefix.replace(/\/+$/, "");
  const out = new Set<string>();
  for (const node of ctx.nodes) {
    if (node.folder === normalised || node.folder.startsWith(normalised + "/")) {
      out.add(node.id);
    }
  }
  return out;
}

function matchImporters(target: string, ctx: FilterContext): FilterResult {
  // Transitive importers of `target` — i.e. files that depend on it,
  // directly or via a chain. Cycle-safe BFS.
  const out = new Set<string>();
  if (!ctx.incoming.has(target)) return out;
  const queue: string[] = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const importers = ctx.incoming.get(current);
    if (!importers) continue;
    for (const imp of importers) {
      if (!out.has(imp)) {
        out.add(imp);
        queue.push(imp);
      }
    }
  }
  return out;
}

function matchRisk(
  op: ">" | "<" | ">=" | "<=" | "=",
  value: number,
  ctx: FilterContext,
): FilterResult {
  const cmp = comparator(op);
  const out = new Set<string>();
  for (const node of ctx.nodes) {
    if (cmp(node.risk, value)) out.add(node.id);
  }
  return out;
}

function matchCore(value: boolean, ctx: FilterContext): FilterResult {
  const out = new Set<string>();
  for (const node of ctx.nodes) {
    if (node.core === value) out.add(node.id);
  }
  return out;
}

function comparator(op: ">" | "<" | ">=" | "<=" | "="): (a: number, b: number) => boolean {
  switch (op) {
    case ">":
      return (a, b) => a > b;
    case "<":
      return (a, b) => a < b;
    case ">=":
      return (a, b) => a >= b;
    case "<=":
      return (a, b) => a <= b;
    case "=":
      return (a, b) => a === b;
  }
}
