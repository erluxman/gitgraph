import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  DEFAULT_EXCLUDES,
  parseConfig,
} from "./index.js";

describe("parseConfig", () => {
  it("returns defaults when given empty object", () => {
    const c = parseConfig({});
    expect(c.corePaths).toEqual([]);
    expect(c.languages).toEqual({});
    expect(c.excludePaths).toEqual(DEFAULT_EXCLUDES);
  });

  it("merges user excludes with defaults", () => {
    const c = parseConfig({ excludePaths: ["scripts/**", "*.test.ts"] });
    expect(c.excludePaths).toContain("scripts/**");
    expect(c.excludePaths).toContain("*.test.ts");
    expect(c.excludePaths).toContain("node_modules/**");
  });

  it("accepts corePaths and language overrides", () => {
    const c = parseConfig({
      corePaths: ["src/core/auth.ts"],
      languages: { "src/**/*.mjs": "javascript" },
    });
    expect(c.corePaths).toEqual(["src/core/auth.ts"]);
    expect(c.languages).toEqual({ "src/**/*.mjs": "javascript" });
  });

  it("rejects non-object input", () => {
    expect(() => parseConfig(null)).toThrow();
    expect(() => parseConfig("string")).toThrow();
  });

  it("rejects malformed excludes / corePaths", () => {
    expect(() => parseConfig({ excludePaths: [1, 2] })).toThrow();
    expect(() => parseConfig({ corePaths: "nope" })).toThrow();
  });

  it("rejects unknown languages", () => {
    expect(() => parseConfig({ languages: { "**/*.py": "python" } })).toThrow();
  });

  it("DEFAULT_CONFIG excludes generated Dart files", () => {
    expect(DEFAULT_CONFIG.excludePaths).toContain("**/*.g.dart");
    expect(DEFAULT_CONFIG.excludePaths).toContain("**/*.freezed.dart");
  });
});
