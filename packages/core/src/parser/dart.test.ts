import { describe, expect, it } from "vitest";
import { parseDart } from "./dart.js";

describe("parseDart: declarations", () => {
  it("extracts public classes, functions, and variables", () => {
    const src = `
      class Foo {}
      class _Hidden {}
      void doThing() {}
      void _internalThing() {}
      const PI = 3.14;
      final _secret = "x";
      typedef IntCallback = void Function(int);
    `;
    const parsed = parseDart("lib/foo.dart", src);
    const names = parsed.exports.map((e) => `${e.kind}:${e.name}`).sort();
    expect(names).toEqual([
      "class:Foo",
      "function:doThing",
      "variable:IntCallback",
      "variable:PI",
    ]);
  });

  it("detects Flutter widget classes", () => {
    const src = `
      import 'package:flutter/material.dart';
      class HomePage extends StatelessWidget {
        @override
        Widget build(BuildContext context) {
          return Container();
        }
      }
      class Counter extends StatefulWidget {
        @override
        State<Counter> createState() => _CounterState();
      }
      class _CounterState extends State<Counter> {
        @override
        Widget build(BuildContext context) => Text("$count");
      }
    `;
    const parsed = parseDart("lib/home.dart", src);
    const widgets = parsed.exports.filter((e) => e.kind === "widget").map((e) => e.name).sort();
    expect(widgets).toEqual(["Counter", "HomePage"]);
    const homePage = parsed.exports.find((e) => e.name === "HomePage");
    expect(homePage?.methods).toContain("build");
  });

  it("excludes private (_-prefixed) symbols", () => {
    const src = `
      class _Foo {}
      void _bar() {}
      const _BAZ = 1;
    `;
    const parsed = parseDart("lib/x.dart", src);
    expect(parsed.exports).toHaveLength(0);
  });

  it("handles enums and mixins", () => {
    const src = `
      enum Status { active, paused }
      mixin Loggable { void log(String msg) {} }
    `;
    const parsed = parseDart("lib/x.dart", src);
    const kinds = parsed.exports.map((e) => `${e.kind}:${e.name}`).sort();
    expect(kinds).toEqual(["class:Loggable", "class:Status"]);
  });
});

describe("parseDart: directives", () => {
  it("captures import / export / part / part of", () => {
    const src = `
      import 'package:flutter/material.dart';
      import '../utils/helpers.dart';
      export 'src/api.dart';
      part 'home_widget.dart';
      part of 'main.dart';
    `;
    const parsed = parseDart("lib/x.dart", src);
    const list = parsed.imports
      .map((i) => `${i.kind}:${i.specifier}`)
      .sort();
    expect(list).toEqual([
      "dart-part-of:main.dart",
      "dart-part:home_widget.dart",
      "reexport:src/api.dart",
      "static:../utils/helpers.dart",
      "static:package:flutter/material.dart",
    ]);
  });

  it("ignores directives that appear inside strings", () => {
    const src = `
      const example = "import 'should_not_match.dart';";
      import 'real.dart';
    `;
    const parsed = parseDart("lib/x.dart", src);
    expect(parsed.imports.map((i) => i.specifier)).toEqual(["real.dart"]);
  });
});

describe("parseDart: line numbers", () => {
  it("reports accurate line numbers for exports and imports", () => {
    const src = `import 'foo.dart';
class Foo {}
void bar() {}`;
    const parsed = parseDart("lib/x.dart", src);
    expect(parsed.imports[0]?.line).toBe(1);
    expect(parsed.exports.find((e) => e.name === "Foo")?.line).toBe(2);
    expect(parsed.exports.find((e) => e.name === "bar")?.line).toBe(3);
  });
});

describe("parseDart: edge cases", () => {
  it("handles triple-quoted strings without misparsing", () => {
    const src = `
      const doc = """
        export 'fake.dart';
        class FakeClass {}
      """;
      class RealClass {}
    `;
    const parsed = parseDart("lib/x.dart", src);
    const classes = parsed.exports.filter((e) => e.kind === "class").map((e) => e.name);
    expect(classes).toEqual(["RealClass"]);
    expect(parsed.imports).toHaveLength(0);
  });

  it("handles nested block comments without misparsing", () => {
    const src = `
      /* outer /* inner */ still in comment */
      class Real {}
    `;
    const parsed = parseDart("lib/x.dart", src);
    expect(parsed.exports.map((e) => e.name)).toEqual(["Real"]);
  });
});
