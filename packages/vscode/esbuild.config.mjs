import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const distDir = resolve(__dirname, "dist");
await mkdir(distDir, { recursive: true });
await mkdir(resolve(distDir, "webview"), { recursive: true });

// Copy static assets used by the extension at runtime.
await copyFile(
  resolve(__dirname, "src/webview/index.html"),
  resolve(distDir, "webview/index.html"),
);

const sharedBundle = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  minify: !watch,
};

const extensionBuild = {
  ...sharedBundle,
  entryPoints: [resolve(__dirname, "src/extension.ts")],
  outfile: resolve(distDir, "extension.js"),
  format: "cjs",
  platform: "node",
  target: "node18",
  // The vscode module is provided by the extension host at runtime —
  // don't try to bundle it.
  external: ["vscode"],
};

const webviewBuild = {
  ...sharedBundle,
  entryPoints: [resolve(__dirname, "src/webview/index.ts")],
  outfile: resolve(distDir, "webview/index.js"),
  format: "iife",
  platform: "browser",
  target: "chrome120",
};

if (watch) {
  const a = await esbuild.context(extensionBuild);
  const b = await esbuild.context(webviewBuild);
  await Promise.all([a.watch(), b.watch()]);
} else {
  await Promise.all([
    esbuild.build(extensionBuild),
    esbuild.build(webviewBuild),
  ]);
}
