import * as esbuild from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const distDir = resolve(__dirname, "dist");
// Always start from a clean dist so we don't ship stale bundle
// filenames (e.g. an old `content.js` left over from a previous
// non-split build, which would otherwise inflate the .zip).
if (!watch) await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const shared = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

const builds = [
  // Always-loaded auto-injected bootstrap. Stays tiny — no PIXI, no
  // orchestrator, no `@gitgraph/core`. Just the button + a message
  // listener that asks the background worker to load the heavy
  // bundle on demand.
  { entryPoints: ["src/content/bootstrap.ts"], outfile: "dist/content-bootstrap.js" },
  // The heavy bundle (PIXI + renderer + orchestrator + GitHub
  // client). Loaded on demand by the background worker via
  // chrome.scripting.executeScript.
  { entryPoints: ["src/content/index.ts"], outfile: "dist/content-renderer.js" },
  // Settings popup.
  { entryPoints: ["src/popup/index.ts"], outfile: "dist/popup.js" },
  // Background service worker — ES module so we can use top-level
  // await if needed.
  {
    entryPoints: ["src/background.ts"],
    outfile: "dist/background.js",
    format: "esm",
  },
];

// Copy static assets next to the bundles.
await Promise.all([
  copyFile(resolve(__dirname, "manifest.json"), resolve(distDir, "manifest.json")),
  copyFile(resolve(__dirname, "popup.html"), resolve(distDir, "popup.html")),
]);

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...shared, ...b });
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...shared, ...b })));
}
