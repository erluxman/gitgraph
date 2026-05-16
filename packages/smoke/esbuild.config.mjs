import * as esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serve = process.argv.includes("--serve");
const distDir = resolve(__dirname, "dist");
await mkdir(distDir, { recursive: true });
await copyFile(resolve(__dirname, "index.html"), resolve(distDir, "index.html"));

const buildOpts = {
  entryPoints: [resolve(__dirname, "src/main.ts")],
  outfile: resolve(distDir, "main.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

if (serve) {
  const ctx = await esbuild.context(buildOpts);
  await ctx.watch();
  const server = await ctx.serve({
    servedir: distDir,
    port: 5173,
    host: "127.0.0.1",
  });
  console.log(`gitGraph smoke test serving on http://${server.host}:${server.port}`);
} else {
  await esbuild.build(buildOpts);
}
