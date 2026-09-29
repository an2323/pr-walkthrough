/**
 * rehearse.ts — prove the DEPLOYED site end to end for $0, then check the result.
 *
 *   pnpm --filter @pr-walkthrough/server rehearse --pr excalidraw/excalidraw#10295 [--plan analysis=critical,verifier=broken] [--site https://host]
 *
 * Starts `POST /api/analyze { rehearsal: true }` on the site: the real pipeline on the real VM
 * (workspace, installs, dev servers, backend confirmation, frames, ablation, storage) with a fake
 * Bob answering from the PR's last real result. Streams the stages, then runs check-run.ts on the
 * rehearsal's result. Exit 0 only when the job finished AND the result passes the rubric.
 *
 * Site and access code default to deploy/.env.production (SITE_ADDRESS, ACCESS_CODE).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(HERE, "../../../deploy/.env.production");

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const fromEnvFile = (key: string): string | undefined => {
  if (!existsSync(ENV_FILE)) return undefined;
  const line = readFileSync(ENV_FILE, "utf-8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
};

const siteAddr = arg("--site") ?? (fromEnvFile("SITE_ADDRESS") ? `https://${fromEnvFile("SITE_ADDRESS")}` : "http://localhost:3000");
const site = siteAddr.replace(/\/$/, "");
const pr = arg("--pr") ?? "excalidraw/excalidraw#10295";
const plan = arg("--plan");
const accessCode = process.env.ACCESS_CODE ?? fromEnvFile("ACCESS_CODE") ?? "";
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(pr);
if (!m) throw new Error(`--pr must look like owner/repo#123, got ${pr}`);
const [, owner, repo, number] = m;

const start = await fetch(`${site}/api/analyze`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prUrl: `https://github.com/${owner}/${repo}/pull/${number}`, rehearsal: true, accessCode, ...(plan ? { plan } : {}) }),
});
const started = (await start.json().catch(() => ({}))) as { jobId?: string; error?: string; rehearsal?: boolean };
if (!start.ok || !started.jobId) {
  console.error(`could not start the rehearsal: HTTP ${start.status} ${started.error ?? ""}`);
  process.exit(1);
}
if (!started.rehearsal) {
  console.error(`the site attached this request to a running job (${started.jobId}) instead of rehearsing — try again when it finishes`);
  process.exit(1);
}
console.log(`rehearsal ${started.jobId}${plan ? ` (plan ${plan})` : ""}`);
console.log(`watch it: ${site}/${owner}/${repo}/${number}/progress?job=${started.jobId}&rehearsal=1\n`);

// Follow the SSE stream until done/error (40 min cap: a cold install + ablation is ~20).
const t0 = Date.now();
const res = await fetch(`${site}/api/jobs/${started.jobId}/events`, { signal: AbortSignal.timeout(40 * 60_000) });
if (!res.ok || !res.body) {
  console.error(`could not follow the job: HTTP ${res.status}`);
  process.exit(1);
}
let buf = "";
let terminal: { kind: string; message?: string; costUsd?: number } | undefined;
const decoder = new TextDecoder();
for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
  buf += decoder.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = block.split("\n").find((l) => l.startsWith("data: "));
    if (!data) continue;
    const e = JSON.parse(data.slice(6)) as { kind: string; label?: string; message?: string; costUsd?: number };
    const at = `${Math.round((Date.now() - t0) / 1000)}s`.padStart(5);
    if (e.kind === "stage") console.log(`${at}  ${e.label}`);
    if (e.kind === "done" || e.kind === "error") terminal = e;
  }
  if (terminal) break;
}

if (!terminal || terminal.kind === "error") {
  console.log(`\nREHEARSAL FAILED: ${terminal?.message ?? "the stream ended without a result"}`);
  process.exit(1);
}
if ((terminal.costUsd ?? 0) > 0) {
  console.log(`\nREHEARSAL FAILED: reported cost $${terminal.costUsd} — a rehearsal must spend nothing`);
  process.exit(1);
}
console.log(`\nfinished in ${Math.round((Date.now() - t0) / 1000)}s — checking the result\n`);
try {
  execFileSync(process.execPath, [...process.execArgv, path.join(HERE, "check-run.ts"), "--site", site, "--pr", pr, "--rehearsal"], { stdio: "inherit" });
} catch {
  process.exit(1);
}
