import type { PrLocator, RepoLocator } from "./github/types.js";

/**
 * Types-only re-export so the lazy-loadable renderer bundle and the
 * always-loaded bootstrap can share message shapes without pulling
 * the heavy `@gitgraph/core` dependency into the bootstrap.
 */
export type ScanTarget =
  | { readonly kind: "pr"; readonly locator: PrLocator }
  | {
      readonly kind: "compare";
      readonly locator: RepoLocator;
      readonly base: string;
      readonly head: string;
    }
  | {
      readonly kind: "snapshot";
      readonly locator: RepoLocator;
      readonly ref: string;
    };
