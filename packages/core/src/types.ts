/**
 * Source language we can parse.
 */
export type Language = "typescript" | "javascript" | "dart";

/**
 * The kind of symbol exported from a source file.
 * Files themselves are always nodes; functions/classes/variables are
 * expandable children of a file node.
 */
export type SymbolKind = "function" | "class" | "variable" | "widget";

/**
 * A symbol exported by a file. Becomes a child node in the graph
 * when the user expands the parent file.
 */
export interface ExportedSymbol {
  readonly kind: SymbolKind;
  readonly name: string;
  readonly line: number;
  /** Methods, for classes. Empty otherwise. */
  readonly methods?: readonly string[];
}

/**
 * Parsed representation of a single source file. The path is always
 * normalised relative to the repo root, using forward slashes.
 */
export interface ParsedFile {
  readonly path: string;
  readonly language: Language;
  readonly exports: readonly ExportedSymbol[];
  /** Raw import specifiers as they appear in source (e.g. "./auth", "react"). */
  readonly imports: readonly RawImport[];
}

export type ImportKind =
  | "static"      // import x from "..."
  | "dynamic"     // import("...")
  | "require"     // require("...")
  | "reexport"    // export { } from "..."
  | "dart-part"   // part "..."
  | "dart-part-of"; // part of "..."

export interface RawImport {
  readonly kind: ImportKind;
  /** The exact specifier string. May be relative ("./x"), package ("react"), or path ("src/x"). */
  readonly specifier: string;
  readonly line: number;
}

/**
 * After resolution, an edge between two file nodes in the graph.
 */
export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly kind: ImportKind;
}

/**
 * Parser output for a whole repo/snapshot.
 */
export interface ParsedRepo {
  readonly files: ReadonlyMap<string, ParsedFile>;
}
