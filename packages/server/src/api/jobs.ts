/**
 * jobs.ts — in-memory job store for the async `POST /api/analyze` pipeline
 * (ST6c). A `Job` holds its status, an ORDERED backlog of every
 * `ProgressEvent` emitted so far (so `GET /api/jobs/:id/events` can replay
 * the full history to a client that connects late or reconnects after a
 * page reload), and the eventual result or error.
 *
 * Single process, no persistence — matches the rest of the backend (the git
 * workspace cache and the budget log are also process-local). Jobs are
 * never garbage-collected; fine for a hackathon demo process that restarts
 * between runs.
 */

import { randomUUID } from "node:crypto";

import type { ProgressEvent } from "@pr-walkthrough/shared";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobResult {
  walkthroughUrl: string;
  qualityWarnings?: { code: string; message: string; stepId?: string }[];
}

export interface Job {
  id: string;
  owner: string;
  repo: string;
  number: number;
  status: JobStatus;
  /** Every progress event emitted so far, oldest first. */
  events: ProgressEvent[];
  result?: JobResult;
  error?: string;
  createdAt: number;
}

interface JobInternal extends Job {
  subscribers: Set<(e: ProgressEvent) => void>;
}

const jobs = new Map<string, JobInternal>();

export function createJob(owner: string, repo: string, number: number): Job {
  const job: JobInternal = {
    id: randomUUID(),
    owner,
    repo,
    number,
    status: "queued",
    events: [],
    createdAt: Date.now(),
    subscribers: new Set(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/**
 * A queued/running job, for the same PR if `pr` is given, else any. Used by
 * `POST /api/analyze` so a double submit or a reload never starts a second
 * paid Bob Shell run (and two runs can't both pass the budget check).
 */
export function findActiveJob(pr?: { owner: string; repo: string; number: number }): Job | undefined {
  for (const job of jobs.values()) {
    if (job.status !== "queued" && job.status !== "running") continue;
    if (!pr || (job.owner === pr.owner && job.repo === pr.repo && job.number === pr.number)) return job;
  }
  return undefined;
}

/**
 * Append a progress event to the job's backlog and fan it out to every live
 * SSE subscriber. The first event flips `queued` → `running`.
 */
export function emitProgress(id: string, event: ProgressEvent): void {
  const job = jobs.get(id);
  if (!job) return;
  if (job.status === "queued") job.status = "running";
  job.events.push(event);
  for (const sub of job.subscribers) sub(event);
}

/** Mark the job done with its final result. Idempotent-ish: last call wins. */
export function completeJob(id: string, result: JobResult): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "done";
  job.result = result;
}

/** Mark the job failed with an error message. */
export function failJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "failed";
  job.error = error;
}

/**
 * Subscribe to LIVE events on a job (nothing retroactive — read `job.events`
 * first for the backlog). Returns an unsubscribe function.
 */
export function subscribeJob(id: string, cb: (e: ProgressEvent) => void): () => void {
  const job = jobs.get(id);
  if (!job) return () => {};
  job.subscribers.add(cb);
  return () => job.subscribers.delete(cb);
}
