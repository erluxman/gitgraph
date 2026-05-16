import { describe, expect, it, vi } from "vitest";
import {
  GitHubClient,
  GitHubRateLimitError,
  parseLinkHeader,
  parsePrUrl,
} from "./client.js";

describe("parsePrUrl", () => {
  it("parses https URLs", () => {
    expect(parsePrUrl("https://github.com/foo/bar/pull/42")).toEqual({
      owner: "foo",
      repo: "bar",
      pull: 42,
    });
  });

  it("parses pathname-only URLs (location.pathname form)", () => {
    expect(parsePrUrl("/foo/bar/pull/42")).toEqual({
      owner: "foo",
      repo: "bar",
      pull: 42,
    });
  });

  it("returns null for unrelated URLs", () => {
    expect(parsePrUrl("https://github.com/foo/bar/issues/42")).toBeNull();
    expect(parsePrUrl("https://example.com")).toBeNull();
  });
});

describe("parseLinkHeader", () => {
  it("returns the URL for the requested rel", () => {
    const link =
      '<https://api.github.com/foo?page=2>; rel="next", <https://api.github.com/foo?page=5>; rel="last"';
    expect(parseLinkHeader(link, "next")).toBe("https://api.github.com/foo?page=2");
    expect(parseLinkHeader(link, "last")).toBe("https://api.github.com/foo?page=5");
  });

  it("returns null when rel is missing or header is empty", () => {
    expect(parseLinkHeader(null, "next")).toBeNull();
    expect(parseLinkHeader("", "next")).toBeNull();
    expect(parseLinkHeader('<https://x>; rel="prev"', "next")).toBeNull();
  });
});

describe("GitHubClient", () => {
  it("passes Authorization header when token supplied", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ head: { ref: "h", sha: "1" }, base: { ref: "b", sha: "2" } }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new GitHubClient({ token: "ghp_test", fetchImpl });
    await client.getPr({ owner: "o", repo: "r", pull: 1 });

    expect(calls).toHaveLength(1);
    const auth = (calls[0]!.init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer ghp_test");
  });

  it("throws GitHubRateLimitError on 403 with remaining=0", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("rate limited", {
        status: 403,
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1700000000",
        },
      });
    }) as unknown as typeof fetch;

    const client = new GitHubClient({ fetchImpl });
    await expect(
      client.getPr({ owner: "o", repo: "r", pull: 1 }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it("paginates listPrFiles using Link header", async () => {
    const responses = [
      new Response(JSON.stringify([{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }]), {
        headers: {
          "Content-Type": "application/json",
          Link: '<https://api.github.com/page2>; rel="next"',
        },
      }),
      new Response(JSON.stringify([{ filename: "b.ts", status: "added", additions: 2, deletions: 0 }]), {
        headers: { "Content-Type": "application/json" },
      }),
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => responses[i++]!) as unknown as typeof fetch;

    const client = new GitHubClient({ fetchImpl });
    const files = await client.listPrFiles({ owner: "o", repo: "r", pull: 1 });
    expect(files.map((f) => f.filename)).toEqual(["a.ts", "b.ts"]);
  });
});
