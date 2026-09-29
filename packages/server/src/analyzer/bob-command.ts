/**
 * bob-command.ts — which program a "bob run" really starts.
 *
 * Normally the real Bob Shell CLI. During a REHEARSAL (`POST /api/analyze { rehearsal: true }`, or
 * `BOB_BIN` for local scripts) it is `scripts/fake-bob.mjs`: same arguments, same stream-json
 * output, $0 — it answers with what the last real run of that PR produced and writes the saved
 * scenario scripts where the verifier would. Everything else in the pipeline is the real thing:
 * git worktrees, installs, dev servers, backend confirmation, frames, ablation, storage, the
 * progress screen. A rehearsal is how a deploy is proven before anyone pays for a run.
 *
 * Per job, not per process: the choice rides on AsyncLocalStorage, so a rehearsal and the live
 * site never share a switch.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_BOB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/fake-bob.mjs");

export interface Rehearsal {
  /** Directory with `walkthrough.json` (the answer) and optionally `verify/` (saved scenario scripts). */
  answersDir: string;
  /** Fault injection, e.g. "analysis=critical,verifier=broken" (see fake-bob.mjs). */
  plan?: string;
}

const current = new AsyncLocalStorage<Rehearsal>();

/** Run `fn` with every Bob call inside it answered by the fake. */
export function withRehearsal<T>(r: Rehearsal, fn: () => Promise<T>): Promise<T> {
  return current.run(r, fn);
}

export function inRehearsal(): Rehearsal | undefined {
  const r = current.getStore();
  if (r) return r;
  return process.env.BOB_BIN === "fake" && process.env.FAKE_BOB_ANSWERS
    ? { answersDir: process.env.FAKE_BOB_ANSWERS, plan: process.env.FAKE_BOB_PLAN }
    : undefined;
}

/** Program + leading args + extra env for one Bob invocation. */
export function bobCommand(): { bin: string; preArgs: string[]; env: Record<string, string> } {
  const r = inRehearsal();
  if (!r) return { bin: process.env.BOB_BIN || "bob", preArgs: [], env: {} };
  return {
    bin: process.execPath,
    preArgs: [FAKE_BOB],
    env: { FAKE_BOB_ANSWERS: r.answersDir, ...(r.plan ? { FAKE_BOB_PLAN: r.plan } : {}) },
  };
}
