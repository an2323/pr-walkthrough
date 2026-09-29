/**
 * warm-app.ts — $0 check that a PR's app can be installed, started and loaded on THIS machine,
 * before a paid run depends on it (a new repo or fork means a cold clone and two cold installs).
 *
 *   pnpm exec tsx scripts/warm-app.ts --pr an2323/excalidraw#21     # on the VM, inside the api container
 *
 * Leaves the clone, both worktrees and their installs in the cache, so the paid run starts warm.
 */
import "../src/env.js";
import path from "node:path";

import { fetchPRMeta } from "../src/github/client.js";
import { ensureWorktree, prepareWorkspace } from "../src/git/workspace.js";
import { ensureInstalled, startApp, warmUp, type AppServer } from "../src/verify/app-servers.js";
import { resolveRecipe } from "../src/verify/recipes.js";

const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const i = process.argv.indexOf("--pr");
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(i >= 0 ? process.argv[i + 1] : "");
if (!m) throw new Error("usage: --pr owner/repo#123");
const [, owner, repo, num] = m;

const t0 = Date.now();
const step = (s: string) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s  ${s}`);

const recipe = await resolveRecipe(owner, repo);
if (!recipe) {
  console.log(`FAIL  no app recipe for ${owner}/${repo} (nor its parent) — a run would have no screenshots`);
  process.exit(1);
}
step(`recipe: ${recipe.repo}`);
const pr = await fetchPRMeta(owner, repo, Number(num));
step(`PR: ${pr.title} (base ${pr.baseSha?.slice(0, 8)}, head ${pr.headSha?.slice(0, 8)})`);
await prepareWorkspace(`https://github.com/${owner}/${repo}`, pr.headSha!, pr.baseSha!, Number(num), GIT_CACHE_DIR);
const mainPath = path.join(GIT_CACHE_DIR, `${owner}__${repo}`);
const baseWt = await ensureWorktree(mainPath, pr.baseSha!);
const headWt = await ensureWorktree(mainPath, pr.headSha!);
step("worktrees ready");
step(`install BASE: ${await ensureInstalled(recipe, baseWt)}`);
step(`install HEAD: ${await ensureInstalled(recipe, headWt, { donor: baseWt })}`);
const servers: AppServer[] = [];
try {
  servers.push(await startApp(recipe, baseWt), await startApp(recipe, headWt));
  for (const [label, s] of [["BASE", servers[0]], ["HEAD", servers[1]]] as const) {
    const { ms } = await warmUp(s.url, { readySelector: recipe.readySelector });
    step(`${label} loads (${Math.round(ms / 1000)}s)`);
  }
  console.log("\nWARM OK — the paid run will start with both apps installed.");
} catch (err) {
  console.log(`\nFAIL  ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await Promise.all(servers.map((s) => s.stop()));
}
