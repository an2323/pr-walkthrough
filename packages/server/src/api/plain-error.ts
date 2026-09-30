/**
 * plain-error.ts — what the reader sees when an analysis fails. The raw error (stderr tails, task
 * ids, stack-ish text) goes to the server log; the progress screen gets one sentence that says
 * what happened and whether anything was spent or saved.
 */

import { outOfCredits } from "../analyzer/bob-shell.js";

export function plainJobError(raw: string): string {
  const r = raw.trim();
  if (outOfCredits(r)) return "Bob is out of credits, so the analysis stopped. Nothing new was saved.";
  if (/Budget guard/i.test(r)) return "The spending limit for analyses on this server has been reached. Nothing was run.";
  if (/no walkthrough found/i.test(r))
    return "Bob finished, but its answer couldn't be read as a walkthrough. The raw answer is kept on the server for recovery.";
  if (/^Validation failed/i.test(r) && /not found in (base|head|diff) file/.test(r))
    return "Bob's walkthrough quoted code that isn't in this PR, even after one automatic repair. Nothing was saved — try again, or try another PR.";
  if (/^Validation failed/i.test(r))
    return `Bob's walkthrough didn't pass the checks, even after one automatic repair (${r.replace(/^Validation failed:\s*/i, "").slice(0, 140)}).`;
  if (/nothing to rehearse with/i.test(r)) return r;
  if (/github|api\.github\.com|rate limit|Not Found/i.test(r) && !/bob/i.test(r))
    return "The pull request couldn't be fetched from GitHub. Check the link, or try again in a minute.";
  if (/\bgit\b|clone|worktree|fetch origin/i.test(r)) return "The repository couldn't be checked out on the server. Try again in a minute.";
  if (/timed? ?out|ETIMEDOUT|SIGTERM|killed/i.test(r)) return "The analysis took too long and was stopped.";
  const first = r.split("\n")[0];
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}
