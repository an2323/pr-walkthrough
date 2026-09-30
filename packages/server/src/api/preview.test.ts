import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Walkthrough } from "@pr-walkthrough/shared";

import { buildPreview, clearPreviewCache, PreviewError, type PreviewDeps } from "./preview.js";

const parse = (url: string) => {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) throw new Error("bad");
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
};

function deps(over: Partial<PreviewDeps> = {}): PreviewDeps {
  return {
    parsePRUrl: parse,
    loadWalkthrough: async () => null,
    fetchPRMeta: async () => ({ title: "fix: x", additions: 30, deletions: 7, filesChanged: 2 }),
    canVerify: async (owner, repo) => `${owner}/${repo}` === "excalidraw/excalidraw",
    ...over,
  };
}

beforeEach(() => {
  clearPreviewCache();
  delete process.env.VERIFY_SHOTS;
  delete process.env.MAX_PR_FILES;
  delete process.env.MAX_PR_DIFF;
});

describe("buildPreview", () => {
  it("excalidraw PR: size, screenshots available", async () => {
    const p = await buildPreview("https://github.com/excalidraw/excalidraw/pull/11286", deps());
    expect(p).toMatchObject({ analysed: false, title: "fix: x", additions: 30, deletions: 7, files: 2, screenshots: { available: true } });
    expect(p.tooBig).toBeUndefined();
  });

  it("another repo: walkthrough only, with the reason as a sentence", async () => {
    const p = await buildPreview("https://github.com/vercel/next.js/pull/70000", deps());
    expect(p.screenshots.available).toBe(false);
    expect(p.screenshots.reason).toMatch(/isn't set up for automatic screenshots/);
  });

  it("already analysed: answered from our store, GitHub is not called", async () => {
    const fetchPRMeta = vi.fn();
    const wt = { plain: { title: "Arrowhead picker no longer falls off the screen" }, pr: { title: "raw" } } as unknown as Walkthrough;
    const p = await buildPreview("https://github.com/excalidraw/excalidraw/pull/10943", deps({ loadWalkthrough: async () => wt, fetchPRMeta }));
    expect(p).toMatchObject({ analysed: true, title: "Arrowhead picker no longer falls off the screen" });
    expect(fetchPRMeta).not.toHaveBeenCalled();
  });

  it("caches GitHub lookups for a few minutes", async () => {
    const fetchPRMeta = vi.fn(async () => ({ title: "t", additions: 1, deletions: 1, filesChanged: 1 }));
    let t = 1_000;
    const d = deps({ fetchPRMeta, now: () => t });
    await buildPreview("https://github.com/a/b/pull/1", d);
    await buildPreview("https://github.com/a/b/pull/1", d);
    expect(fetchPRMeta).toHaveBeenCalledTimes(1);
    t += 6 * 60 * 1000;
    await buildPreview("https://github.com/a/b/pull/1", d);
    expect(fetchPRMeta).toHaveBeenCalledTimes(2);
  });

  it("says when the PR is over the size caps", async () => {
    const p = await buildPreview("https://github.com/a/b/pull/1", deps({ fetchPRMeta: async () => ({ title: "t", additions: 3000, deletions: 10, filesChanged: 5 }) }));
    expect(p.tooBig).toMatch(/3010 lines.*2000/);
    const q = await buildPreview("https://github.com/a/b/pull/2", deps({ fetchPRMeta: async () => ({ title: "t", additions: 5, deletions: 1, filesChanged: 120 }) }));
    expect(q.tooBig).toMatch(/120 files.*80/);
  });

  it("not a PR link → 400; unknown PR → 404; GitHub trouble → 502", async () => {
    await expect(buildPreview("https://github.com/a/b", deps())).rejects.toMatchObject({ status: 400 });
    await expect(buildPreview("https://github.com/a/b/pull/9", deps({ fetchPRMeta: async () => { throw new Error("GitHub 404 Not Found"); } }))).rejects.toMatchObject({ status: 404 });
    await expect(buildPreview("https://github.com/a/b/pull/8", deps({ fetchPRMeta: async () => { throw new Error("socket hang up"); } }))).rejects.toBeInstanceOf(PreviewError);
    await expect(buildPreview("https://github.com/a/b/pull/7", deps({ fetchPRMeta: async () => { throw new Error("socket hang up"); } }))).rejects.toMatchObject({ status: 502 });
  });

  it("screenshots switched off on the server → not available, says so", async () => {
    process.env.VERIFY_SHOTS = "0";
    const p = await buildPreview("https://github.com/excalidraw/excalidraw/pull/1", deps());
    expect(p.screenshots).toMatchObject({ available: false, reason: expect.stringMatching(/turned off/) });
  });
});
