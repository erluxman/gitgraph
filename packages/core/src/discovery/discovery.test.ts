import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/index.js";
import {
  detectMonorepo,
  discoverFiles,
  globToRegex,
  readPackageJsonName,
  readPubspecName,
} from "./index.js";

describe("globToRegex", () => {
  it("matches simple filename globs", () => {
    expect(globToRegex("*.ts").test("foo.ts")).toBe(true);
    expect(globToRegex("*.ts").test("foo.tsx")).toBe(false);
    expect(globToRegex("*.ts").test("sub/foo.ts")).toBe(false);
  });

  it("matches **/ for nested paths", () => {
    const re = globToRegex("**/*.test.ts");
    expect(re.test("foo.test.ts")).toBe(true);
    expect(re.test("a/b/foo.test.ts")).toBe(true);
    expect(re.test("foo.ts")).toBe(false);
  });

  it("matches directory prefixes", () => {
    const re = globToRegex("node_modules/**");
    expect(re.test("node_modules/foo/bar.js")).toBe(true);
    expect(re.test("src/foo.js")).toBe(false);
  });

  it("supports alternation", () => {
    const re = globToRegex("**/*.{ts,tsx}");
    expect(re.test("a/b.ts")).toBe(true);
    expect(re.test("a/b.tsx")).toBe(true);
    expect(re.test("a/b.js")).toBe(false);
  });
});

describe("discoverFiles", () => {
  it("filters by language extension", () => {
    const files = discoverFiles([
      "src/foo.ts",
      "src/bar.js",
      "lib/widget.dart",
      "README.md",
      "image.png",
    ]);
    const result = files.map((f) => `${f.language}:${f.path}`).sort();
    expect(result).toEqual([
      "dart:lib/widget.dart",
      "javascript:src/bar.js",
      "typescript:src/foo.ts",
    ]);
  });

  it("excludes default-excluded paths", () => {
    const files = discoverFiles([
      "src/foo.ts",
      "node_modules/x/index.js",
      "dist/bundle.js",
      "lib/x.g.dart",
    ]);
    expect(files.map((f) => f.path)).toEqual(["src/foo.ts"]);
  });

  it("respects user-supplied excludes", () => {
    const config = parseConfig({ excludePaths: ["src/legacy/**"] });
    const files = discoverFiles(
      ["src/foo.ts", "src/legacy/old.ts", "src/new/x.ts"],
      config,
    );
    expect(files.map((f) => f.path)).toEqual(["src/foo.ts", "src/new/x.ts"]);
  });

  it("honours language overrides", () => {
    const config = parseConfig({ languages: { "src/**/*.mjs": "javascript" } });
    const files = discoverFiles(["src/utils/x.mjs"], config);
    expect(files).toEqual([{ path: "src/utils/x.mjs", language: "javascript" }]);
  });
});

describe("detectMonorepo", () => {
  it("detects npm workspaces from package.json", () => {
    const json = JSON.stringify({ workspaces: ["packages/*", "apps/*"] });
    expect(detectMonorepo({ packageJson: json })).toEqual({
      kind: "npm",
      roots: ["packages/*", "apps/*"],
    });
  });

  it("detects pnpm workspaces from yaml", () => {
    const yaml = `packages:\n  - 'packages/*'\n  - apps/web\n`;
    expect(detectMonorepo({ pnpmWorkspaceYaml: yaml })).toEqual({
      kind: "pnpm",
      roots: ["packages/*", "apps/web"],
    });
  });

  it("detects lerna", () => {
    const json = JSON.stringify({ packages: ["modules/*"] });
    expect(detectMonorepo({ lernaJson: json })).toEqual({
      kind: "lerna",
      roots: ["modules/*"],
    });
  });

  it("detects melos for Flutter", () => {
    const yaml = `name: my_workspace\npackages:\n  - "packages/*"\n  - apps/mobile\n`;
    expect(detectMonorepo({ melosYaml: yaml })).toEqual({
      kind: "melos",
      roots: ["packages/*", "apps/mobile"],
    });
  });

  it("falls back to single-package when no config matches", () => {
    expect(detectMonorepo({})).toEqual({ kind: "single", roots: [""] });
  });

  it("does not crash on malformed package.json", () => {
    expect(detectMonorepo({ packageJson: "not json" })).toEqual({
      kind: "single",
      roots: [""],
    });
  });
});

describe("readPackageJsonName", () => {
  it("extracts a scoped name", () => {
    const body = JSON.stringify({ name: "@scope/pkg", version: "1.0.0" });
    expect(readPackageJsonName(body)).toBe("@scope/pkg");
  });

  it("returns null for malformed JSON", () => {
    expect(readPackageJsonName("not json")).toBeNull();
  });

  it("returns null when name is missing or not a string", () => {
    expect(readPackageJsonName("{}")).toBeNull();
    expect(readPackageJsonName('{"name": 42}')).toBeNull();
  });
});

describe("readPubspecName", () => {
  it("extracts a top-level name", () => {
    const yaml = `name: my_app\nversion: 1.0.0\n`;
    expect(readPubspecName(yaml)).toBe("my_app");
  });

  it("supports quoted names", () => {
    expect(readPubspecName(`name: "my_app"\n`)).toBe("my_app");
    expect(readPubspecName(`name: 'my_app'\n`)).toBe("my_app");
  });

  it("ignores nested name fields", () => {
    const yaml = `description: foo\ndependencies:\n  name: bar\n`;
    expect(readPubspecName(yaml)).toBeNull();
  });

  it("returns null when no name is present", () => {
    expect(readPubspecName("version: 1.0.0\n")).toBeNull();
  });
});
