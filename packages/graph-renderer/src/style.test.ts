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
  it("renders each impact at its flat base colour, full opacity", () => {
    const green = nodeStyle(node({ impact: "green" }));
    const orange = nodeStyle(node({ impact: "orange", distance: 1 }));
    const red = nodeStyle(node({ impact: "red" }));
    expect(green.fill).toBe(COLOURS.green);
    expect(orange.fill).toBe(COLOURS.orange);
    expect(red.fill).toBe(COLOURS.red);
    expect(green.alpha).toBe(1);
    expect(orange.alpha).toBe(1);
    expect(red.alpha).toBe(1);
  });

  it("does not fade orange by distance or red by risk", () => {
    const closeOrange = nodeStyle(node({ impact: "orange", distance: 1 }));
    const farOrange = nodeStyle(node({ impact: "orange", distance: 9 }));
    expect(closeOrange.fill).toBe(farOrange.fill);
    expect(closeOrange.alpha).toBe(farOrange.alpha);

    const calmRed = nodeStyle(node({ impact: "red", risk: 0 }));
    const riskyRed = nodeStyle(node({ impact: "red", risk: 1 }));
    expect(calmRed.fill).toBe(riskyRed.fill);
  });

  it("scales radius with export count", () => {
    const small = nodeStyle(node({ exportCount: 1 }), { maxExports: 100 });
    const big = nodeStyle(node({ exportCount: 100 }), { maxExports: 100 });
    expect(big.radius).toBeGreaterThan(small.radius);
  });

  it("forces a doubled minimum radius for changed (red) nodes regardless of exports", () => {
    const zeroExports = nodeStyle(
      node({ impact: "red", exportCount: 0 }),
      { maxExports: 100 },
    );
    expect(zeroExports.radius).toBeGreaterThanOrEqual(32);
  });

  it("gives red files a 3px white ring; non-red core files keep the yellow glow", () => {
    const plain = nodeStyle(node({ core: false }));
    const core = nodeStyle(node({ core: true }));
    const redPlain = nodeStyle(node({ impact: "red", core: false }));
    const redCore = nodeStyle(node({ impact: "red", core: true }));
    expect(plain.borderColour).toBeNull();
    expect(core.borderColour).toBe(COLOURS.core);
    expect(core.borderWidth).toBe(2);
    expect(redPlain.borderColour).toBe(COLOURS.redBorder);
    expect(redPlain.borderWidth).toBe(3);
    // Red wins over core: changed files keep the white ring even when
    // they're a core path.
    expect(redCore.borderColour).toBe(COLOURS.redBorder);
    expect(redCore.borderWidth).toBe(3);
  });
});
