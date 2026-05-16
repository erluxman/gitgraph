import { describe, expect, it } from "vitest";
import type { RawImport } from "../types.js";
import { resolveImport, type ResolverContext } from "./resolver.js";

function ctx(opts: {
  files: readonly string[];
  packages?: Record<string, string>;
  dartPackages?: Record<string, string>;
}): ResolverContext {
  return {
    files: new Set(opts.files),
    packages: new Map(Object.entries(opts.packages ?? {})),
    dartPackages: new Map(Object.entries(opts.dartPackages ?? {})),
  };
}

const staticImport = (specifier: string): RawImport => ({
  kind: "static",
  specifier,
  line: 1,
});

describe("resolveImport: TypeScript relative paths", () => {
  it("resolves './foo' from same dir with .ts extension", () => {
    const c = ctx({ files: ["src/a.ts", "src/foo.ts"] });
    expect(resolveImport("src/a.ts", staticImport("./foo"), "typescript", c))
      .toBe("src/foo.ts");
  });

  it("resolves './foo' to index file when foo is a directory", () => {
    const c = ctx({ files: ["src/a.ts", "src/foo/index.ts"] });
    expect(resolveImport("src/a.ts", staticImport("./foo"), "typescript", c))
      .toBe("src/foo/index.ts");
  });

  it("prefers exact file over index/", () => {
    const c = ctx({ files: ["src/a.ts", "src/foo.ts", "src/foo/index.ts"] });
    expect(resolveImport("src/a.ts", staticImport("./foo"), "typescript", c))
      .toBe("src/foo.ts");
  });

  it("resolves '../bar/baz'", () => {
    const c = ctx({ files: ["src/a/b.ts", "src/bar/baz.ts"] });
    expect(resolveImport("src/a/b.ts", staticImport("../bar/baz"), "typescript", c))
      .toBe("src/bar/baz.ts");
  });

  it("returns null for unknown relative paths", () => {
    const c = ctx({ files: ["src/a.ts"] });
    expect(resolveImport("src/a.ts", staticImport("./missing"), "typescript", c))
      .toBeNull();
  });

  it("returns null for bare external packages", () => {
    const c = ctx({ files: ["src/a.ts"] });
    expect(resolveImport("src/a.ts", staticImport("react"), "typescript", c))
      .toBeNull();
  });

  it("resolves tsx files for './Component'", () => {
    const c = ctx({ files: ["src/a.tsx", "src/Component.tsx"] });
    expect(resolveImport("src/a.tsx", staticImport("./Component"), "typescript", c))
      .toBe("src/Component.tsx");
  });
});

describe("resolveImport: workspace packages", () => {
  it("resolves bare @scope/pkg specifier to package src/index", () => {
    const c = ctx({
      files: ["packages/core/src/index.ts"],
      packages: { "@gitgraph/core": "packages/core" },
    });
    expect(
      resolveImport(
        "packages/chrome/src/x.ts",
        staticImport("@gitgraph/core"),
        "typescript",
        c,
      ),
    ).toBe("packages/core/src/index.ts");
  });

  it("resolves subpath of workspace package", () => {
    const c = ctx({
      files: ["packages/core/src/parser/index.ts"],
      packages: { "@gitgraph/core": "packages/core" },
    });
    expect(
      resolveImport(
        "packages/chrome/src/x.ts",
        staticImport("@gitgraph/core/parser"),
        "typescript",
        c,
      ),
    ).toBe("packages/core/src/parser/index.ts");
  });

  it("returns null for non-workspace bare specifier", () => {
    const c = ctx({
      files: ["src/x.ts"],
      packages: { "@scope/pkg": "packages/pkg" },
    });
    expect(
      resolveImport("src/x.ts", staticImport("react"), "typescript", c),
    ).toBeNull();
  });
});

describe("resolveImport: Dart", () => {
  it("resolves package:my_app/foo.dart via dartPackages", () => {
    const c = ctx({
      files: ["packages/my_app/lib/foo.dart"],
      dartPackages: { my_app: "packages/my_app" },
    });
    expect(
      resolveImport(
        "lib/main.dart",
        staticImport("package:my_app/foo.dart"),
        "dart",
        c,
      ),
    ).toBe("packages/my_app/lib/foo.dart");
  });

  it("returns null for package:flutter (external)", () => {
    const c = ctx({ files: ["lib/main.dart"] });
    expect(
      resolveImport(
        "lib/main.dart",
        staticImport("package:flutter/material.dart"),
        "dart",
        c,
      ),
    ).toBeNull();
  });

  it("returns null for dart:core", () => {
    const c = ctx({ files: ["lib/main.dart"] });
    expect(
      resolveImport("lib/main.dart", staticImport("dart:async"), "dart", c),
    ).toBeNull();
  });

  it("resolves relative Dart paths", () => {
    const c = ctx({ files: ["lib/a.dart", "lib/b.dart"] });
    expect(
      resolveImport("lib/a.dart", staticImport("b.dart"), "dart", c),
    ).toBe("lib/b.dart");
  });
});
