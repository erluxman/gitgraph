import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const distDir = resolve(__dirname, "dist");
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
  { entryPoints: ["src/content/index.ts"], outfile: "dist/content.js" },
  { entryPoints: ["src/popup/index.ts"], outfile: "dist/popup.js" },
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
