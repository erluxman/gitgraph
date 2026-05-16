/**
 * Strongly-typed wrappers around chrome.storage.local. Falls back to
 * localStorage when running outside a chrome extension context (tests).
 */
/**
 * `mode = "auto"` defers the choice until the scan runs:
 *   - token present → deep (5000/hr means we can afford the complete graph)
 *   - no token      → light (60/hr means we have to be frugal)
 *
 * Users who want a guaranteed answer can pin "light" or "deep" themselves.
 */
export type ScanMode = "auto" | "light" | "deep";

export interface ExtensionSettings {
  readonly githubToken?: string;
  readonly mode: ScanMode;
  readonly excludePathsOverride: readonly string[];
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  mode: "auto",
  excludePathsOverride: [],
};

/** Resolve the user-facing mode setting to a concrete scan strategy. */
export function resolveMode(s: ExtensionSettings): "light" | "deep" {
  if (s.mode === "light" || s.mode === "deep") return s.mode;
  return s.githubToken !== undefined ? "deep" : "light";
}

const KEY = "gitgraph:settings";

declare const chrome: {
  storage?: {
    local?: {
      get(keys: string[], cb: (v: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, cb: () => void): void;
    };
  };
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const raw = await readRaw();
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<ExtensionSettings>;
    const mode: ScanMode =
      parsed.mode === "light" || parsed.mode === "deep" || parsed.mode === "auto"
        ? parsed.mode
        : "auto";
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      mode,
      excludePathsOverride: Array.isArray(parsed.excludePathsOverride)
        ? parsed.excludePathsOverride.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(value: ExtensionSettings): Promise<void> {
  await writeRaw(JSON.stringify(value));
}

function readRaw(): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get([KEY], (items) => {
        const v = items[KEY];
        resolve(typeof v === "string" ? v : null);
      });
      return;
    }
    resolve(globalThis.localStorage?.getItem(KEY) ?? null);
  });
}

function writeRaw(value: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({ [KEY]: value }, () => resolve());
      return;
    }
    globalThis.localStorage?.setItem(KEY, value);
    resolve();
  });
}
