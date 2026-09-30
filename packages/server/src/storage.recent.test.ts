import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listRecentFromFiles } from "./storage.js";

async function put(dir: string, owner: string, repo: string, n: string, body: unknown, when: number) {
  const d = path.join(dir, owner, repo);
  await mkdir(d, { recursive: true });
  const f = path.join(d, n);
  await writeFile(f, typeof body === "string" ? body : JSON.stringify(body));
  await utimes(f, when / 1000, when / 1000);
}

describe("listRecentFromFiles", () => {
  it("lists finished walkthroughs newest first with the fields the landing cards need", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "recent-"));
    await put(dir, "a", "x", "1.json", { plain: { title: "Old one" }, meta: {} }, 1_000_000);
    await put(dir, "a", "x", "2.json", { plain: { title: "New one", problem: "It broke" }, shots: { before: { src: "before-annotated.png" } }, meta: { run: { costUsd: 0.87 } } }, 9_000_000);
    await put(dir, "b", "y", "7.json", "{ not json", 5_000_000);
    await put(dir, "b", "y", "notes.txt", "ignored", 6_000_000);
    const list = await listRecentFromFiles(10, dir);
    expect(list.map((r) => `${r.owner}/${r.repo}#${r.number}`)).toEqual(["a/x#2", "a/x#1"]);
    expect(list[0]).toMatchObject({ title: "New one", problem: "It broke", thumb: "before-annotated.png", costUsd: 0.87 });
    expect(list[1]).toMatchObject({ title: "Old one" });
    expect(list[1]!.costUsd).toBeUndefined();
  });

  it("respects the limit and an empty or missing folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "recent-"));
    for (let i = 1; i <= 4; i++) await put(dir, "o", "r", `${i}.json`, { plain: { title: `t${i}` } }, i * 1_000_000);
    expect(await listRecentFromFiles(2, dir)).toHaveLength(2);
    expect(await listRecentFromFiles(5, path.join(dir, "nope"))).toEqual([]);
  });
});
