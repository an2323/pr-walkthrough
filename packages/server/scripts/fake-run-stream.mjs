#!/usr/bin/env node
/**
 * fake-run-stream.mjs — plays a whole analysis run for the progress screen, for $0, nothing paid, nothing deployed.
 *
 * It answers GET /api/jobs/<any id>/events with the events a real run sends (plan with estimate, files, reading,
 * writing, scenario, screenshots with counted replays, frames, outcome, ablation builds, fact check, narration,
 * done), at SPEED times real speed. Everything else (/data/..., other /api/...) is served from this repo's data
 * folder or passed on to the live site, so the viewer that opens at the end works too.
 *
 *   node packages/server/scripts/fake-run-stream.mjs            # listens on :3001, SPEED=6 (a 23-minute run in ~4 min)
 *   API_TARGET=http://localhost:3001 pnpm --filter @pr-walkthrough/web exec vite --port 5173
 *   open http://localhost:5173/excalidraw/excalidraw/10295/progress?job=fake
 *
 * Env: PORT (3001), SPEED (6), FALLBACK (live site for anything not handled here).
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3001);
const SPEED = Number(process.env.SPEED ?? 6);
const FALLBACK = process.env.FALLBACK ?? 'https://130-61-220-249.sslip.io';
const DATA = resolve(fileURLToPath(new URL('../../../data', import.meta.url)));

const FILES = [
  'packages/excalidraw/components/dropdownMenu/DropdownMenuContent.tsx',
  'packages/excalidraw/components/dropdownMenu/DropdownMenuTrigger.tsx',
  'packages/excalidraw/components/Sidebar/Sidebar.tsx',
  'packages/excalidraw/css/styles.scss',
  'packages/excalidraw/components/App.tsx',
];
const PR = { title: 'fix: close floating sidebar on main menu open', additions: 19, deletions: 7, files: FILES.length };

/** [simulated seconds, event without t] — `t` is filled in when the event is sent. */
const T = [];
const at = (s, e) => T.push([s, e]);

at(0, { kind: 'stage', stage: 'clone', label: 'Checked out the PR' });
at(4, { kind: 'plan', pr: PR, shots: { planned: true }, voice: { planned: true }, estimate: { minMinutes: 16, maxMinutes: 29, ablationBuilds: 10, coldInstall: true } });
at(6, { kind: 'stage', stage: 'hunks', label: '5 hunks' });
at(7, { kind: 'files', files: FILES.map((path, i) => ({ path, additions: 4 - (i % 3), deletions: 1 + (i % 2), skipped: i === 3 })) });
at(10, { kind: 'stage', stage: 'analyzing', label: 'Bob is analysing the PR' });
FILES.forEach((f, i) => at(14 + i * 22, { kind: 'tool', tool: 'read_file', target: `Reading ${f}` }));
at(60, { kind: 'tool', tool: 'spawn_subagent', target: 'Sub-agent: how the sidebar is stacked' });
at(90, { kind: 'tool', tool: 'grep', target: 'Searching for `zIndex-ui`' });
for (let c = 0, s = 130; s <= 330; s += 10, c += 2300) at(s, { kind: 'writing', chars: 2000 + c });
for (const [s, usd] of [[40, 0.4], [120, 0.9], [200, 1.3], [320, 1.7]]) at(s, { kind: 'cost', costUsd: usd });
at(340, { kind: 'stage', stage: 'validating', label: 'Checking the walkthrough against the diff' });
at(350, { kind: 'scenario', lines: ['Open the main menu while the sidebar is open', 'Check that the sidebar closes by itself'] });
at(356, { kind: 'stage', stage: 'saving', label: 'Saved' });
at(365, { kind: 'stage', stage: 'app', label: 'Installing the app at the old and the new version' });
at(470, { kind: 'stage', stage: 'app', label: 'Starting the app at the old and the new version' });
at(520, { kind: 'stage', stage: 'shots', label: 'Bob is reproducing the change and taking screenshots' });
at(530, { kind: 'tool', tool: 'read_file', target: 'Reading .walkthrough/pr.diff' });
at(550, { kind: 'tool', tool: 'write_file', target: 'Writing repro.cjs' });
at(570, { kind: 'tool', tool: 'execute_command', target: 'Running `node repro.cjs --base`' });
at(600, { kind: 'tool', tool: 'execute_command', target: 'Running `node repro.cjs --head`' });
at(625, { kind: 'cost', costUsd: 2.0 });
at(640, { kind: 'stage', stage: 'shots', label: 'Trying "Open the main menu while the sidebar is open" on the old and the new version (1 of 2)' });
at(700, { kind: 'stage', stage: 'shots', label: 'Trying "Sidebar closes by itself" on the old and the new version (2 of 2)' });
at(760, { kind: 'frames', before: 'before-annotated.png', after: 'after-annotated.png', caption: 'Same clicks, both versions' });
at(762, { kind: 'outcome', what: 'shots', code: 'ok', message: 'The bug reproduced at the old commit and is gone at the new one.' });
at(770, { kind: 'stage', stage: 'ablation', label: 'Testing which changes fix the bug' });
for (let k = 1; k <= 10; k++) {
  at(775 + (k - 1) * 60, { kind: 'stage', stage: 'ablation', label: `Testing "${FILES[k % 2]}#${1 + (k % 3)}" alone (${k} of 10, about a minute each)` });
  if (k % 3 === 0) at(775 + (k - 1) * 60 + 30, { kind: 'cost', costUsd: 2.0 + k * 0.12 });
}
at(1380, { kind: 'stage', stage: 'ablation', label: 'Measured 5 change(s) against the running app' });
at(1392, { kind: 'stage', stage: 'factcheck', label: 'Fact-checking the explanation — comparing what the text says with what the app actually did' });
at(1450, { kind: 'stage', stage: 'factcheck', label: 'Fixed 1 statement(s) the app contradicted' });
at(1460, { kind: 'stage', stage: 'voicing', label: 'Recording the narration' });
at(1520, { kind: 'cost', costUsd: 3.4 });
at(1560, { kind: 'done', walkthroughUrl: '/excalidraw/excalidraw/10295', durationMs: 1560_000, costUsd: 3.4, toolCalls: 11, subagents: 1 });

const jobs = new Map(); // id → start time (the run starts when the first viewer connects)

function events(req, res, id) {
  if (!jobs.has(id)) jobs.set(id, Date.now());
  const start = jobs.get(id);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let i = 0;
  const tick = () => {
    const simSec = ((Date.now() - start) / 1000) * SPEED;
    while (i < T.length && T[i][0] <= simSec) {
      res.write(`data: ${JSON.stringify({ ...T[i][1], t: Math.round(T[i][0] * 1000) })}\n\n`);
      i += 1;
    }
    if (i >= T.length) { clearInterval(timer); res.end(); }
  };
  const timer = setInterval(tick, 500);
  req.on('close', () => clearInterval(timer));
  tick();
}

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ndjson': 'text/plain' };

async function fallback(req, res) {
  try {
    const up = await fetch(FALLBACK + req.url, { method: req.method, headers: { accept: req.headers.accept ?? '*/*' } });
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/octet-stream' });
    res.end(Buffer.from(await up.arrayBuffer()));
  } catch {
    res.writeHead(502).end();
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = /^\/api\/jobs\/([^/]+)\/events$/.exec(url.pathname);
  if (m) return events(req, res, m[1]);
  if (url.pathname.startsWith('/data/')) {
    const file = normalize(join(DATA, url.pathname.slice('/data/'.length)));
    if (file.startsWith(DATA) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      return createReadStream(file).pipe(res);
    }
  }
  return fallback(req, res);
}).listen(PORT, () => console.log(`fake run on :${PORT} (SPEED ${SPEED}x, ~${Math.round(1560 / SPEED / 60)} min). Open …/progress?job=fake`));
