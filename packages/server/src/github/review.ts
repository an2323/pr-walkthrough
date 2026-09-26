/**
 * github/review.ts — post reviewer comments from the viewer onto a GitHub PR (ST6d).
 *
 * Comments never go to the analysed (upstream) PR: a walkthrough is mapped to the demo
 * PR in GITHUB_DEMO_REPO#GITHUB_DEMO_PR only when it matches GITHUB_DEMO_SOURCE and the
 * demo PR sits on the same head SHA. The write token (GITHUB_TOKEN_WRITE) stays here.
 *
 * CodeLines carry no line numbers, so a line is located in the file at the right SHA by
 * its text, disambiguated by the neighbouring lines of the same block. Lines inside a
 * diff hunk become PR review comments; anything else (or a 422 from GitHub) becomes a
 * general PR comment with a permalink.
 */

import type { CodeLine, Walkthrough } from "@pr-walkthrough/shared";

const GITHUB_API = "https://api.github.com";
const NEIGHBOURS = 5;

export type Side = "LEFT" | "RIGHT";

export interface CommentAnchor {
  file: string;
  revision: "base" | "head" | "diff";
  lines: Pick<CodeLine, "kind" | "text">[];
  index: number;
}

export interface ReviewTarget {
  repo: string; // "an2323/excalidraw"
  number: number;
  url: string;
  headSha: string;
  baseSha: string;
}

export interface PostedComment {
  url: string;
  kind: "line" | "general";
  path?: string;
  line?: number;
  side?: Side;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Which side of the diff a block line lives on. */
export function sideOf(revision: CommentAnchor["revision"], kind: CodeLine["kind"]): Side {
  if (revision === "base") return "LEFT";
  if (revision === "head") return "RIGHT";
  return kind === "removed" ? "LEFT" : "RIGHT";
}

/**
 * 1-based line number of `lines[index]` in `fileLines`, or null if the text isn't there.
 * Candidates are scored by how many same-side neighbours (up to NEIGHBOURS each way,
 * stopping at an elided line) also match; ties go to the first candidate.
 */
export function locateLine(fileLines: string[], anchor: CommentAnchor): number | null {
  const target = anchor.lines[anchor.index];
  if (!target || target.kind === "elided") return null;
  const side = sideOf(anchor.revision, target.kind);
  const norm = (s: string) => s.trimEnd();
  const file = fileLines.map(norm);

  const sameSide = (l: Pick<CodeLine, "kind">) =>
    l.kind === "elided" || sideOf(anchor.revision, l.kind) === side;
  const collect = (from: number, step: 1 | -1): (string | null)[] => {
    const out: (string | null)[] = [];
    for (let i = from; i >= 0 && i < anchor.lines.length && out.length < NEIGHBOURS; i += step) {
      const l = anchor.lines[i];
      if (!sameSide(l)) continue;
      if (l.kind === "elided") break;
      out.push(norm(l.text));
    }
    return out;
  };
  const before = collect(anchor.index - 1, -1);
  const after = collect(anchor.index + 1, 1);

  const needle = norm(target.text);
  let best: number | null = null;
  let bestScore = -1;
  for (let p = 0; p < file.length; p++) {
    if (file[p] !== needle) continue;
    let score = 0;
    before.forEach((t, k) => { if (file[p - 1 - k] === t) score++; });
    after.forEach((t, k) => { if (file[p + 1 + k] === t) score++; });
    if (score > bestScore) {
      best = p + 1;
      bestScore = score;
    }
  }
  return best;
}

/** Line numbers a review comment may target, per side, from a unified-diff `patch`. */
export function commentableLines(patch: string): { LEFT: Set<number>; RIGHT: Set<number> } {
  const out = { LEFT: new Set<number>(), RIGHT: new Set<number>() };
  let oldLn = 0;
  let newLn = 0;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      oldLn = parseInt(h[1], 10);
      newLn = parseInt(h[2], 10);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      out.RIGHT.add(newLn++);
    } else if (raw.startsWith("-")) {
      out.LEFT.add(oldLn++);
    } else {
      out.LEFT.add(oldLn++);
      out.RIGHT.add(newLn++);
    }
  }
  return out;
}

export function permalink(repo: string, sha: string, file: string, line?: number): string {
  return `https://github.com/${repo}/blob/${sha}/${file}${line ? `#L${line}` : ""}`;
}

export function generalCommentBody(
  body: string,
  loc: { repo: string; sha: string; file: string; line: number | null; text: string }
): string {
  const where = loc.line ? `\`${loc.file}\` line ${loc.line}` : `\`${loc.file}\``;
  const quote = loc.text.trim() ? `\n\n\`\`\`\n${loc.text.trimEnd()}\n\`\`\`` : "";
  return `**${where}** ([view](${permalink(loc.repo, loc.sha, loc.file, loc.line ?? undefined)}))${quote}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// GitHub I/O
// ---------------------------------------------------------------------------

function token(): string {
  return process.env.GITHUB_TOKEN_WRITE ?? "";
}

async function gh<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitHubError(res.status, `GitHub API ${res.status} for ${method} ${url}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const targetCache = new Map<string, Promise<ReviewTarget | { disabled: string }>>();

/** The PR comments for this walkthrough go to, or why posting is off. */
export function resolveTarget(wt: Walkthrough): Promise<ReviewTarget | { disabled: string }> {
  const demoRepo = process.env.GITHUB_DEMO_REPO ?? "";
  const demoPr = parseInt(process.env.GITHUB_DEMO_PR ?? "", 10);
  const source = process.env.GITHUB_DEMO_SOURCE ?? "excalidraw/excalidraw#10295";
  if (!token()) return Promise.resolve({ disabled: "GITHUB_TOKEN_WRITE is not set" });
  if (!demoRepo || isNaN(demoPr)) return Promise.resolve({ disabled: "GITHUB_DEMO_REPO / GITHUB_DEMO_PR are not set" });
  if (`${wt.pr.repo}#${wt.pr.number}` !== source) {
    return Promise.resolve({ disabled: `Only ${source} has a demo PR to post to` });
  }

  const key = `${demoRepo}#${demoPr}@${wt.pr.headSha}`;
  let cached = targetCache.get(key);
  if (!cached) {
    cached = gh<{ html_url: string; head: { sha: string }; base: { sha: string } }>(
      "GET", `${GITHUB_API}/repos/${demoRepo}/pulls/${demoPr}`
    ).then(
      (pr) =>
        pr.head.sha === wt.pr.headSha
          ? { repo: demoRepo, number: demoPr, url: pr.html_url, headSha: pr.head.sha, baseSha: pr.base.sha }
          : { disabled: `${demoRepo}#${demoPr} head ${pr.head.sha.slice(0, 7)} ≠ walkthrough head ${wt.pr.headSha?.slice(0, 7)}` },
      (err: unknown) => {
        targetCache.delete(key); // retry next time — may be a transient network error
        return { disabled: `Cannot reach ${demoRepo}#${demoPr}: ${String(err)}` };
      }
    );
    targetCache.set(key, cached);
  }
  return cached;
}

const fileCache = new Map<string, Promise<string[]>>();

async function fileAt(repo: string, sha: string, file: string): Promise<string[]> {
  const key = `${repo}@${sha}:${file}`;
  let cached = fileCache.get(key);
  if (!cached) {
    const url = `${GITHUB_API}/repos/${repo}/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`;
    cached = gh<{ content: string; encoding: string }>("GET", url).then((r) =>
      Buffer.from(r.content, r.encoding === "base64" ? "base64" : "utf8").toString("utf8").replace(/\r\n/g, "\n").split("\n")
    );
    cached.catch(() => fileCache.delete(key));
    fileCache.set(key, cached);
  }
  return cached;
}

const patchCache = new Map<string, Promise<Map<string, string>>>();

async function patches(target: ReviewTarget): Promise<Map<string, string>> {
  const key = `${target.repo}#${target.number}@${target.headSha}`;
  let cached = patchCache.get(key);
  if (!cached) {
    cached = gh<{ filename: string; patch?: string }[]>(
      "GET", `${GITHUB_API}/repos/${target.repo}/pulls/${target.number}/files?per_page=100`
    ).then((files) => new Map(files.map((f) => [f.filename, f.patch ?? ""])));
    cached.catch(() => patchCache.delete(key));
    patchCache.set(key, cached);
  }
  return cached;
}

async function postGeneral(target: ReviewTarget, body: string): Promise<PostedComment> {
  const r = await gh<{ html_url: string }>(
    "POST", `${GITHUB_API}/repos/${target.repo}/issues/${target.number}/comments`, { body }
  );
  return { url: r.html_url, kind: "general" };
}

/** Where an anchored line lives on the target PR: side, SHA, line number, and whether it's in the diff. */
export async function resolveAnchor(
  target: ReviewTarget,
  anchor: CommentAnchor
): Promise<{ side: Side; sha: string; line: number | null; inDiff: boolean }> {
  const side = sideOf(anchor.revision, anchor.lines[anchor.index].kind);
  const sha = side === "LEFT" ? target.baseSha : target.headSha;
  const fileLines = await fileAt(target.repo, sha, anchor.file).catch(() => null);
  const line = fileLines ? locateLine(fileLines, anchor) : null;
  const patch = line ? (await patches(target)).get(anchor.file) : undefined;
  return { side, sha, line, inDiff: !!(line && patch && commentableLines(patch)[side].has(line)) };
}

/** Post `body` on the target PR, on the anchored line if it's inside the diff. */
export async function postComment(
  target: ReviewTarget,
  body: string,
  anchor?: CommentAnchor
): Promise<PostedComment> {
  if (!anchor) return postGeneral(target, body);

  const { side, sha, line: ln, inDiff } = await resolveAnchor(target, anchor);
  if (ln && inDiff) {
    try {
      const r = await gh<{ html_url: string }>(
        "POST", `${GITHUB_API}/repos/${target.repo}/pulls/${target.number}/comments`,
        { body, commit_id: target.headSha, path: anchor.file, line: ln, side }
      );
      return { url: r.html_url, kind: "line", path: anchor.file, line: ln, side };
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err;
    }
  }

  const text = anchor.lines[anchor.index].text;
  const general = generalCommentBody(body, { repo: target.repo, sha, file: anchor.file, line: ln, text });
  const posted = await postGeneral(target, general);
  return { ...posted, path: anchor.file, line: ln ?? undefined, side };
}
