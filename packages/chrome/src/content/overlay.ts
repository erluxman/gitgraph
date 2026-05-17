import {
  buildSceneFromCore,
  buildSkeletonScene,
  mountCommandPalette,
  mountControlsPanel,
  mountRenderer,
  type CommandPaletteHandle,
  type ControlsPanelHandle,
  type RendererHandle,
} from "@gitgraph/graph-renderer";
import {
  GitHubClient,
  GitHubHttpError,
  GitHubRateLimitError,
} from "../github/client.js";
import type { RepoLocator } from "../github/types.js";
import { runScan, type ScanSnapshot, type ScanTarget } from "../orchestrator.js";
import { loadSettings, resolveMode } from "./storage.js";

const OVERLAY_ID = "gitgraph-overlay-root";

/**
 * Open the full-screen graph overlay over the current GitHub PR page.
 * Closes via Escape or the X button. Idempotent — calling twice is a no-op.
 */
export async function openOverlay(target: ScanTarget): Promise<void> {
  if (document.getElementById(OVERLAY_ID) !== null) return;

  const settings = await loadSettings();
  const client = new GitHubClient({ token: settings.githubToken });
  const locator: RepoLocator = target.locator;

  const root = buildShell();
  document.body.appendChild(root);
  document.body.style.overflow = "hidden";

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  const aborter = new AbortController();
  const closeButton = root.querySelector<HTMLButtonElement>(".gg-close")!;
  closeButton.addEventListener("click", close);

  const status = root.querySelector<HTMLDivElement>(".gg-status")!;
  const canvasHost = root.querySelector<HTMLDivElement>(".gg-canvas")!;

  let handle: RendererHandle | null = null;
  let panel: ControlsPanelHandle | null = null;
  let palette: CommandPaletteHandle | null = null;
  let activeTarget: ScanTarget = target;
  // We mount the renderer once with a skeleton scene as soon as we
  // have tree paths, then call setScene() with the final scene at done.
  // Both steps are kicked off from inside `emit`, which is sync — so
  // we track them as promises and await them after runScan resolves.
  let skeletonMounted = false;
  let mountPromise: Promise<void> | null = null;
  let finalSwapPromise: Promise<void> | null = null;
  let finalSnap: ScanSnapshot | null = null;

  try {
    await runScan({
      client,
      target,
      mode: resolveMode(settings),
      signal: aborter.signal,
      emit(snap) {
        renderProgress(status, snap);

        // First emit with tree paths populated → mount the skeleton.
        if (
          !skeletonMounted &&
          snap.sourcePaths.length > 0 &&
          handle === null
        ) {
          skeletonMounted = true;
          const skeleton = buildSkeletonScene({
            sourcePaths: snap.sourcePaths,
            changedPaths: snap.changedFiles,
          });
          mountPromise = (async () => {
            const rect = canvasHost.getBoundingClientRect();
            handle = await mountRenderer(skeleton, {
              container: canvasHost,
              width: rect.width,
              height: rect.height,
            });
            console.log("[gitGraph] skeleton mounted", handle);
          })().catch((err) => {
            console.error("[gitGraph] skeleton mount failed", err);
          });
        }

        if (snap.phase === "done" && snap.graph && snap.diff && snap.risk) {
          finalSnap = snap;
        }
      },
    });

    // Hoist the non-null fields out so the async IIFE below doesn't
    // re-widen them. The cast on `finalSnap` defeats TS's narrowing of
    // a closure-mutated `let` — without it, TS keeps `finalSnap` at
    // its initial `null` type even though it gets assigned in `emit`.
    const completed: ScanSnapshot | null = finalSnap as ScanSnapshot | null;
    const finalGraph = completed?.graph ?? null;
    const finalDiffResult = completed?.diff ?? null;
    const finalRiskMap = completed?.risk ?? null;
    if (
      completed !== null &&
      finalGraph !== null &&
      finalDiffResult !== null &&
      finalRiskMap !== null
    ) {
      console.log("[gitGraph] runScan done — swapping to final scene", completed);
      if (mountPromise !== null) await mountPromise;
      finalSwapPromise = (async () => {
        const scene = buildSceneFromCore({
          graph: finalGraph,
          diff: finalDiffResult,
          risk: finalRiskMap,
        });
        // Cast defeats TS's closure-mutation narrowing on `handle`.
        const existing = handle as RendererHandle | null;
        if (existing === null) {
          // Skeleton didn't mount (e.g. tree was empty) — mount the
          // final scene directly.
          const rect = canvasHost.getBoundingClientRect();
          handle = await mountRenderer(scene, {
            container: canvasHost,
            width: rect.width,
            height: rect.height,
          });
        } else {
          await existing.setScene(scene);
        }
        console.log("[gitGraph] final scene applied", handle);
        renderFilesPanel(root, completed);
        // Mount the controls panel + palette the first time the final
        // scene lands. Subsequent re-scans (via the branch picker)
        // only need updateScene().
        // Same closure-narrowing trick used elsewhere in this file:
        // capturing `panel`/`palette` in inner async functions confuses
        // TS, so we cast them through an alias.
        const existingPanel = panel as ControlsPanelHandle | null;
        const existingPalette = palette as CommandPaletteHandle | null;
        if (existingPanel === null && handle !== null) {
          panel = mountControlsPanel(canvasHost, handle, { scene });
          palette = mountCommandPalette(canvasHost, handle, { scene });
          // Fire-and-forget — the branch list comes back async.
          void wireBranchPicker(panel, client, locator, activeTarget, applyTarget);
        } else {
          existingPanel?.updateScene(scene);
          existingPalette?.updateScene(scene);
        }
        status.style.color = "";
        status.textContent = `${completed.repo.files.size} files parsed · ${completed.changedFiles.length} changed`;
      })();
      await finalSwapPromise;
    } else {
      status.textContent = "Scan completed but no final snapshot was emitted.";
    }
  } catch (e) {
    console.error("[gitGraph] scan/mount failed", e);
    renderError(status, e, { hasToken: settings.githubToken !== undefined, locator });
  }

  function close(): void {
    aborter.abort();
    document.removeEventListener("keydown", onKey);
    handle?.destroy();
    panel?.destroy();
    palette?.destroy();
    root.remove();
    document.body.style.overflow = "";
  }

  /**
   * Re-run the scan with a new ScanTarget (branch swap from the panel).
   * Mirrors the original orchestrator wiring but feeds the result back
   * into the existing renderer via setScene().
   */
  async function applyTarget(next: ScanTarget): Promise<void> {
    if (handle === null) throw new Error("renderer not ready");
    activeTarget = next;
    status.style.color = "";
    status.textContent = "Re-scanning…";
    const snap = await runScan({
      client,
      target: next,
      mode: resolveMode(settings),
      signal: aborter.signal,
      emit(s) {
        status.textContent = `${s.message} (${Math.round(s.progress * 100)}%)`;
      },
    });
    if (
      snap.graph === null ||
      snap.diff === null ||
      snap.risk === null
    ) {
      throw new Error("re-scan returned no graph");
    }
    const newScene = buildSceneFromCore({
      graph: snap.graph,
      diff: snap.diff,
      risk: snap.risk,
    });
    await handle.setScene(newScene);
    panel?.updateScene(newScene);
    palette?.updateScene(newScene);
    renderFilesPanel(root, snap);
    status.textContent = `${snap.repo.files.size} files parsed · ${snap.changedFiles.length} changed`;
  }
}

/**
 * Fetch the repo's branches and feed them to the controls panel's
 * branch selector. Picks sensible defaults based on the current scan
 * target: a PR scan defaults to its base/head; a snapshot defaults to
 * the snapshot ref + no compare.
 */
async function wireBranchPicker(
  panel: ControlsPanelHandle,
  client: GitHubClient,
  locator: RepoLocator,
  currentTarget: ScanTarget,
  apply: (next: ScanTarget) => Promise<void>,
): Promise<void> {
  try {
    const branches = await client.listBranches(locator);
    const names = branches.map((b) => b.name);
    const { currentBase, currentHead } = await deriveCurrentBranches(
      client,
      locator,
      currentTarget,
    );
    panel.setBranchSelector({
      branches: names,
      currentBase,
      currentHead,
      async onApply(base, head) {
        if (head === "" || head === base) {
          await apply({ kind: "snapshot", locator, ref: base });
        } else {
          await apply({ kind: "compare", locator, base, head });
        }
      },
    });
  } catch (err) {
    // Don't break the overlay — just leave the picker empty. The user
    // can still use everything else.
    console.warn("[gitGraph] couldn't load branches", err);
  }
}

async function deriveCurrentBranches(
  client: GitHubClient,
  _locator: RepoLocator,
  target: ScanTarget,
): Promise<{ currentBase: string; currentHead: string }> {
  switch (target.kind) {
    case "pr": {
      const meta = await client.getPr(target.locator);
      return { currentBase: meta.base.ref, currentHead: meta.head.ref };
    }
    case "compare":
      return { currentBase: target.base, currentHead: target.head };
    case "snapshot":
      return { currentBase: target.ref, currentHead: "" };
  }
}

function renderProgress(status: HTMLDivElement, snap: ScanSnapshot): void {
  status.textContent = `${snap.message} (${Math.round(snap.progress * 100)}%)`;
}

/**
 * Translate a thrown error into something the user can actually act on.
 * GitHub returns 404 (not 403) when a token can't see a private resource,
 * to avoid leaking existence — so a 404 on /pulls/{n} is almost always
 * an auth/access issue, not a missing PR.
 */
function renderError(
  status: HTMLDivElement,
  e: unknown,
  ctx: { hasToken: boolean; locator: RepoLocator },
): void {
  status.style.color = "#fca5a5";
  status.style.lineHeight = "1.5";

  if ((e as { name?: string }).name === "AbortError") {
    // User closed the overlay before the scan finished. No message needed.
    status.textContent = "";
    return;
  }

  if (e instanceof GitHubRateLimitError) {
    status.innerHTML = ctx.hasToken
      ? `<strong>Rate limit hit even with a token.</strong> Wait until ${
          e.resetAt ? new Date(e.resetAt).toLocaleTimeString() : "the reset time"
        } and try again, or use Light scan in the popup.`
      : `<strong>GitHub rate limit hit.</strong> Open the gitGraph popup and add a personal access token — that lifts the limit from 60/hr to 5000/hr.`;
    return;
  }

  if (e instanceof GitHubHttpError && e.status === 404 && /\/pulls\/\d+/.test(e.url)) {
    const org = ctx.locator.owner;
    if (!ctx.hasToken) {
      status.innerHTML = `<strong>Can't access this PR.</strong> It's likely private — open the gitGraph popup and add a GitHub token with access to <code>${escapeHtmlAttr(`${ctx.locator.owner}/${ctx.locator.repo}`)}</code>.`;
      return;
    }
    status.innerHTML = `<strong>Can't access this PR with your current token.</strong> Common causes:
      <ul style="margin:4px 0 0 18px;padding:0;color:#fecaca;">
        <li>Token isn't authorized for the <code>${escapeHtmlAttr(org)}</code> org — <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" style="color:#93c5fd;">enable SSO</a> on it</li>
        <li>Token's repository access doesn't include this repo — recreate with <code>${escapeHtmlAttr(`${ctx.locator.owner}/${ctx.locator.repo}`)}</code> selected, or <code>repo</code> scope for classic tokens</li>
        <li>Fine-grained token pending org approval — check <a href="https://github.com/organizations/${encodeURIComponent(org)}/settings/personal-access-tokens" target="_blank" rel="noreferrer" style="color:#93c5fd;">org settings</a></li>
      </ul>`;
    return;
  }

  if (e instanceof GitHubHttpError && e.status === 401) {
    status.innerHTML = `<strong>Token rejected.</strong> Open the gitGraph popup and check the token — it may be expired or mistyped.`;
    return;
  }

  // /compare/{base}...{head} returns 404 when one of the refs doesn't
  // exist, and 422 when the refs share no merge base (unrelated
  // histories — e.g. branches from different repos). Surface both
  // separately so the user knows which to fix.
  if (e instanceof GitHubHttpError && /\/compare\//.test(e.url)) {
    if (e.status === 404) {
      status.innerHTML = `<strong>One of the branches doesn't exist.</strong> Open the popup and check the base/compare picks — they may have been deleted or renamed.`;
      return;
    }
    if (e.status === 422) {
      status.innerHTML = `<strong>No common history between those branches.</strong> Compare needs a shared merge base; pick branches from the same line of work.`;
      return;
    }
  }

  status.textContent = `Scan failed: ${(e as Error).message}`;
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * Side panel listing the changed files. Each file is colour-coded by
 * whether it landed in the graph (red, parsed source) or was filtered
 * out (grey, e.g. .md / .json). Lets the user verify at a glance that
 * the picture they see matches the PR diff.
 */
function renderFilesPanel(root: HTMLDivElement, snap: ScanSnapshot): void {
  const panel = document.createElement("aside");
  panel.className = "gg-files";
  Object.assign(panel.style, {
    position: "absolute",
    top: "60px",
    right: "16px",
    width: "260px",
    maxHeight: "70vh",
    overflow: "auto",
    background: "rgba(17, 24, 39, 0.92)",
    border: "1px solid #1f2937",
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "12px",
    color: "#e5e7eb",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
  } satisfies Partial<CSSStyleDeclaration>);

  const parsed = new Set(snap.repo.files.keys());
  // Show ALL files from the PR diff, not just the source-filtered set —
  // that way the user can see "yes my .md/.json files were intentionally
  // skipped" instead of wondering where they went.
  const files = snap.allChangedFiles.length > 0 ? snap.allChangedFiles : snap.changedFiles;
  const inGraph = files.filter((p) => parsed.has(p)).length;
  const total = files.length;

  const rows = files
    .map((path) => {
      const isInGraph = parsed.has(path);
      const dot = isInGraph
        ? '<span style="display:inline-block;width:8px;height:8px;background:#ef4444;border-radius:50%;margin-right:6px;vertical-align:middle;"></span>'
        : '<span style="display:inline-block;width:8px;height:8px;background:#374151;border-radius:50%;margin-right:6px;vertical-align:middle;"></span>';
      const colour = isInGraph ? "#e5e7eb" : "#6b7280";
      return `<li style="padding:2px 0;color:${colour};word-break:break-all;">${dot}${escapeHtml(path)}</li>`;
    })
    .join("");

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <strong style="font-family:ui-sans-serif,system-ui,sans-serif;">Changed files</strong>
      <span style="font-size:11px;color:#9ca3af;font-family:ui-sans-serif,system-ui,sans-serif;">${inGraph}/${total} in graph</span>
    </div>
    <ul style="list-style:none;margin:0;padding:0;">${rows}</ul>
    ${
      inGraph < total
        ? '<div style="margin-top:8px;font-size:11px;color:#9ca3af;font-family:ui-sans-serif,system-ui,sans-serif;">Grey items are non-source files (e.g. .md, .json, .yml) and are intentionally excluded.</div>'
        : ""
    }
  `;
  root.appendChild(panel);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildShell(): HTMLDivElement {
  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.setAttribute("data-gg-overlay", "");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    background: "rgba(10, 14, 26, 0.92)",
    backdropFilter: "blur(8px)",
    display: "flex",
    flexDirection: "column",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    color: "#e5e7eb",
  } satisfies Partial<CSSStyleDeclaration>);
  root.innerHTML = `
    <header style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid #1f2937;">
      <div style="display:flex;align-items:center;gap:14px;">
        <strong>gitGraph</strong>
        <div class="gg-legend" style="display:flex;gap:12px;font-size:12px;color:#9ca3af;">
          <span><span style="display:inline-block;width:10px;height:10px;background:#ef4444;border-radius:50%;margin-right:6px;vertical-align:middle;"></span>changed</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#f97316;border-radius:50%;margin-right:6px;vertical-align:middle;"></span>downstream</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#4ade80;border-radius:50%;margin-right:6px;vertical-align:middle;"></span>unaffected</span>
        </div>
      </div>
      <button class="gg-close" type="button" aria-label="Close" style="background:transparent;border:1px solid #374151;color:#e5e7eb;border-radius:6px;padding:4px 10px;cursor:pointer;">Close (Esc)</button>
    </header>
    <div class="gg-status" style="padding:8px 20px;font-size:12px;color:#9ca3af;border-bottom:1px solid #111827;">Loading…</div>
    <div class="gg-canvas" style="flex:1;position:relative;overflow:hidden;"></div>
  `;
  return root;
}
