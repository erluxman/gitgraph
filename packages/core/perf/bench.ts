/**
 * Synthetic-repo benchmark for the core pipeline.
 *
 *   bun run perf:bench
 *
 * Generates a realistic-shaped TypeScript repo (some hub files imported
 * by many, most leaves imported by few), runs the full pipeline at
 * several scales, and prints per-phase timings. Useful for spotting
 * regressions before a real-world monorepo trips into them.
 *
 * "Realistic" here means: 10% of files are hubs (imported by everything),
 * 30% are mid-tier (imported by ~5 files), 60% are leaves (no importers).
 */
import {
  analyseDiff,
  buildGraph,
  parseFile,
  scoreRisk,
  type ParsedFile,
  type ParsedRepo,
} from "../src/index.js";

interface Phase {
  readonly label: string;
  readonly ms: number;
}

interface RunResult {
  readonly fileCount: number;
  readonly phases: readonly Phase[];
  readonly totalMs: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

function generateRepo(fileCount: number): Map<string, string> {
  const out = new Map<string, string>();
  const hubCount = Math.max(1, Math.floor(fileCount * 0.1));
  const midCount = Math.max(1, Math.floor(fileCount * 0.3));
  const leafCount = fileCount - hubCount - midCount;

  // Hubs: leaf-like contents, lots of exports.
  for (let i = 0; i < hubCount; i++) {
    const exports = [];
    for (let j = 0; j < 8; j++) {
      exports.push(`export function hub${i}_fn${j}() {}`);
    }
    out.set(`src/hubs/hub${i}.ts`, exports.join("\n"));
  }

  // Mids: each imports 2-3 hubs and exports a couple of functions.
  for (let i = 0; i < midCount; i++) {
    const imports: string[] = [];
    const hubsToImport = 2 + (i % 2);
    for (let k = 0; k < hubsToImport; k++) {
      const hubIdx = (i + k * 37) % hubCount;
      imports.push(`import "../hubs/hub${hubIdx}";`);
    }
    const exports = [];
    for (let j = 0; j < 3; j++) {
      exports.push(`export const mid${i}_v${j} = ${j};`);
    }
    out.set(`src/mids/mid${i}.ts`, [...imports, ...exports].join("\n"));
  }

  // Leaves: each imports 1-2 mids, no exports of consequence.
  for (let i = 0; i < leafCount; i++) {
    const imports: string[] = [];
    const midsToImport = 1 + (i % 2);
    for (let k = 0; k < midsToImport; k++) {
      const midIdx = (i + k * 13) % midCount;
      imports.push(`import "../mids/mid${midIdx}";`);
    }
    out.set(
      `src/leaves/leaf${i}.ts`,
      [...imports, `export const leaf${i} = ${i};`].join("\n"),
    );
  }

  return out;
}

function timed<T>(label: string, fn: () => T): { value: T; phase: Phase } {
  const start = performance.now();
  const value = fn();
  const ms = performance.now() - start;
  return { value, phase: { label, ms } };
}

function runAt(fileCount: number): RunResult {
  const sources = generateRepo(fileCount);
  const phases: Phase[] = [];

  // Phase 1: parse every file.
  const parsed = timed("parse", () => {
    const m = new Map<string, ParsedFile>();
    for (const [path, source] of sources) {
      m.set(path, parseFile(path, source, "typescript"));
    }
    return m;
  });
  phases.push(parsed.phase);
  const repo: ParsedRepo = { files: parsed.value };

  // Phase 2: build graph.
  const graphResult = timed("buildGraph", () => buildGraph({ repo }));
  phases.push(graphResult.phase);
  const graph = graphResult.value;

  // Phase 3: classify diff with 1% of files as "changed".
  const changedCount = Math.max(1, Math.floor(fileCount * 0.01));
  const changedFiles = [...sources.keys()].slice(0, changedCount);
  const diff = timed("analyseDiff", () => analyseDiff({ graph, changedFiles }));
  phases.push(diff.phase);

  // Phase 4: risk score (includes PageRank).
  const risk = timed("scoreRisk", () => scoreRisk(graph));
  phases.push(risk.phase);

  const totalMs = phases.reduce((s, p) => s + p.ms, 0);
  return {
    fileCount,
    phases,
    totalMs,
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
  };
}

function fmt(n: number): string {
  return n.toFixed(1).padStart(7);
}

function printRun(r: RunResult): void {
  console.log(
    `\n--- ${r.fileCount.toLocaleString()} files · ${r.nodeCount} nodes · ${r.edgeCount} edges ---`,
  );
  for (const phase of r.phases) {
    const pct = ((phase.ms / r.totalMs) * 100).toFixed(1).padStart(5);
    console.log(`  ${phase.label.padEnd(14)} ${fmt(phase.ms)} ms   (${pct}%)`);
  }
  console.log(`  ${"total".padEnd(14)} ${fmt(r.totalMs)} ms`);
}

const scales = [100, 500, 1000, 5000];
const argScale = process.argv[2];
if (argScale !== undefined) {
  const n = Number(argScale);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Usage: bun run perf:bench [fileCount]`);
    process.exit(1);
  }
  printRun(runAt(n));
} else {
  console.log("gitGraph core pipeline benchmark");
  console.log(`(hubs ~10%, mids ~30%, leaves ~60%; 1% files marked changed)`);
  for (const n of scales) printRun(runAt(n));
}
