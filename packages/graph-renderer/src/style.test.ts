import { describe, expect, it } from "vitest";
import { COLOURS, nodeStyle } from "./style.js";
import type { SceneNode } from "./types.js";

function node(overrides: Partial<SceneNode>): SceneNode {
  return {
    id: "src/a.ts",
    path: "src/a.ts",
    folder: "src",
    displayName: "a.ts",
    exportCount: 1,
    impact: "green",
    distance: Infinity,
    risk: 0,
    core: false,
    ...overrides,
  };
}

describe("nodeStyle", () => {
  it("uses the green base colour for unaffected files", () => {
    const s = nodeStyle(node({ impact: "green" }));
    // Green base, darkened to ~35% intensity → still a recognisable green shade.
    expect(s.fill).not.toBe(COLOURS.red);
    expect(s.fill).not.toBe(COLOURS.orange);
  });

  it("scales radius with export count", () => {
    const small = nodeStyle(node({ exportCount: 1 }), { maxExports: 100 });
    const big = nodeStyle(node({ exportCount: 100 }), { maxExports: 100 });
    expect(big.radius).toBeGreaterThan(small.radius);
  });

  it("forces a minimum radius for changed (red) nodes regardless of exports", () => {
    const zeroExports = nodeStyle(
      node({ impact: "red", exportCount: 0 }),
      { maxExports: 100 },
    );
    expect(zeroExports.radius).toBeGreaterThanOrEqual(16);
  });

  it("orange nodes get fading alpha proportional to distance", () => {
    const close = nodeStyle(node({ impact: "orange", distance: 1 }));
    const far = nodeStyle(node({ impact: "orange", distance: 5 }));
    expect(close.alpha).toBeGreaterThan(far.alpha);
    expect(close.alpha).toBeCloseTo(1, 5);
    expect(far.alpha).toBeCloseTo(0.4, 5);
  });

  it("red nodes get higher intensity with higher risk", () => {
    const low = nodeStyle(node({ impact: "red", risk: 0 }));
    const high = nodeStyle(node({ impact: "red", risk: 1 }));
    // Higher risk → brighter (closer to full red).
    expect(redChannel(high.fill)).toBeGreaterThan(redChannel(low.fill));
  });

  it("adds a glow border for core paths", () => {
    const plain = nodeStyle(node({ core: false }));
    const core = nodeStyle(node({ core: true }));
    expect(plain.borderColour).toBeNull();
    expect(core.borderColour).toBe(COLOURS.core);
    expect(core.borderWidth).toBeGreaterThan(0);
  });
});

function redChannel(hex: number): number {
  return (hex >> 16) & 0xff;
}
