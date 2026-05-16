import { GitHubClient, parseRepoUrl } from "../github/client.js";
import type { RepoLocator } from "../github/types.js";
import type { PopupToContent } from "../messages.js";
import {
  loadSettings,
  saveSettings,
  type ScanMode,
} from "../content/storage.js";

declare const chrome: {
  tabs?: {
    query(
      q: { active: boolean; currentWindow: boolean },
      cb: (tabs: { id?: number; url?: string }[]) => void,
    ): void;
    sendMessage(tabId: number, msg: PopupToContent, cb?: (r: unknown) => void): void;
  };
  runtime?: { lastError?: { message: string } };
};

interface ActiveContext {
  readonly tabId: number;
  readonly locator: RepoLocator;
}

let activeContext: ActiveContext | null = null;
let branchNames: readonly string[] = [];

async function init(): Promise<void> {
  setupSettings();
  await setupCompare();
}

// ---------- Settings ----------

function setupSettings(): void {
  const tokenEl = document.getElementById("token") as HTMLInputElement;
  const modeEl = document.getElementById("mode") as HTMLSelectElement;
  const excludesEl = document.getElementById("excludes") as HTMLTextAreaElement;
  const saveEl = document.getElementById("save") as HTMLButtonElement;
  const statusEl = document.getElementById("settings-status") as HTMLDivElement;

  loadSettings().then((current) => {
    tokenEl.value = current.githubToken ?? "";
    modeEl.value = current.mode;
    excludesEl.value = current.excludePathsOverride.join("\n");
  });

  saveEl.addEventListener("click", async () => {
    const token = tokenEl.value.trim();
    const rawMode = modeEl.value;
    const mode: ScanMode =
      rawMode === "light" || rawMode === "deep" || rawMode === "auto"
        ? rawMode
        : "auto";
    await saveSettings({
      ...(token.length > 0 ? { githubToken: token } : {}),
      mode,
      excludePathsOverride: excludesEl.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    });
    statusEl.textContent = "Saved.";
    statusEl.classList.remove("error");
    setTimeout(() => {
      statusEl.textContent = "";
    }, 1500);
    // Re-fetch branches in case the token changed.
    await setupCompare();
  });
}

// ---------- Compare branches ----------

async function setupCompare(): Promise<void> {
  const hint = document.getElementById("compare-hint") as HTMLDivElement;
  const baseSelect = document.getElementById("base-branch") as HTMLSelectElement;
  const headSelect = document.getElementById("head-branch") as HTMLSelectElement;
  const openButton = document.getElementById("open-graph") as HTMLButtonElement;
  const reloadButton = document.getElementById("reload-branches") as HTMLButtonElement;
  const status = document.getElementById("compare-status") as HTMLDivElement;

  reloadButton.onclick = () => void setupCompare();
  openButton.onclick = () => void openGraph();

  // 1. Discover the active tab and parse its URL for a repo.
  const tab = await getActiveTab();
  if (tab === null || tab.url === undefined) {
    hint.textContent = "Switch to a github.com tab to compare branches.";
    return;
  }
  const locator = parseRepoUrl(tab.url);
  if (locator === null) {
    hint.textContent = `This tab isn't on a GitHub repo (${shortenUrl(tab.url)}).`;
    return;
  }
  activeContext = { tabId: tab.id!, locator };
  hint.innerHTML = `Repo: <strong>${escape(locator.owner)}/${escape(locator.repo)}</strong>`;

  // 2. Fetch the branch list using the saved token.
  const settings = await loadSettings();
  const client = new GitHubClient({ token: settings.githubToken });

  baseSelect.disabled = true;
  headSelect.disabled = true;
  openButton.disabled = true;
  status.textContent = "Fetching branches…";
  status.classList.remove("error");

  try {
    const [branches, repoInfo] = await Promise.all([
      client.listBranches(locator),
      client.getRepo(locator),
    ]);
    branchNames = branches.map((b) => b.name);
    populateSelect(baseSelect, branchNames, repoInfo.defaultBranch);
    populateSelect(headSelect, ["", ...branchNames]);
    baseSelect.disabled = false;
    headSelect.disabled = false;
    openButton.disabled = false;
    status.textContent = `${branchNames.length} branches loaded.`;
    setTimeout(() => {
      if (status.textContent?.startsWith(`${branchNames.length}`)) status.textContent = "";
    }, 2000);
  } catch (err) {
    status.classList.add("error");
    status.textContent = describeError(err);
  }
}

async function openGraph(): Promise<void> {
  const baseSelect = document.getElementById("base-branch") as HTMLSelectElement;
  const headSelect = document.getElementById("head-branch") as HTMLSelectElement;
  const status = document.getElementById("compare-status") as HTMLDivElement;

  if (activeContext === null) return;
  const base = baseSelect.value;
  if (base === "") {
    status.classList.add("error");
    status.textContent = "Pick a base branch first.";
    return;
  }
  const head = headSelect.value;

  const target: PopupToContent["target"] =
    head === "" || head === base
      ? { kind: "snapshot", locator: activeContext.locator, ref: base }
      : { kind: "compare", locator: activeContext.locator, base, head };

  status.classList.remove("error");
  status.textContent = "Opening overlay…";
  try {
    await sendToTab(activeContext.tabId, { kind: "open-overlay", target });
    status.textContent = "Done — check the active tab.";
    setTimeout(() => window.close(), 600);
  } catch (err) {
    status.classList.add("error");
    status.textContent = describeError(err);
  }
}

// ---------- Helpers ----------

function getActiveTab(): Promise<{ id?: number; url?: string } | null> {
  return new Promise((resolve) => {
    if (!chrome.tabs?.query) {
      resolve(null);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0] ?? null);
    });
  });
}

function sendToTab(tabId: number, msg: PopupToContent): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!chrome.tabs?.sendMessage) {
      reject(new Error("chrome.tabs API unavailable"));
      return;
    }
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      const err = chrome.runtime?.lastError;
      if (err !== undefined) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function populateSelect(
  el: HTMLSelectElement,
  items: readonly string[],
  selected?: string,
): void {
  el.innerHTML = "";
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item;
    opt.textContent = item === "" ? "(no comparison — snapshot view)" : item;
    if (item === selected) opt.selected = true;
    el.appendChild(opt);
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Rate-limit hit while listing branches — usually means no token.
    if (err.message.includes("rate limit")) {
      return "GitHub rate limit hit. Add a token in Settings (60/hr → 5000/hr).";
    }
    // 401 / 403 with token present = token mismatch
    if (err.message.includes("401") || /403/.test(err.message)) {
      return "GitHub rejected the request. Check the token in Settings — it may be expired or lack access to this repo.";
    }
    if (err.message.includes("404")) {
      return "Couldn't read the repo. If it's private, add a token in Settings with access to it.";
    }
    return err.message;
  }
  return String(err);
}

void init();
