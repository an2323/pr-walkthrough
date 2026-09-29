/**
 * blobs.ts — screenshots, narration mp3s and progress recordings in Supabase
 * Storage (public bucket), so they outlive the VM. Keys mirror the local
 * data/ layout: `shots/{owner}/{repo}/{n}/…`, `audio/{owner}/{repo}/{n}/…`,
 * `events/{owner}/{repo}/{n}.ndjson`.
 *
 * Enabled when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set; otherwise
 * everything stays on the local disk, as before.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const BUCKET = process.env.SUPABASE_BUCKET ?? "walkthrough-assets";

/**
 * Storage needs the project's HTTPS API URL (https://<ref>.supabase.co). A database
 * connection string in this variable is an easy mix-up — and using it would put its
 * password into every request error — so anything that isn't a plain http(s) URL
 * without credentials disables Storage instead, and the value is never printed.
 */
export function isPlainHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

let warnedBadUrl = false;

function config(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  if (!isPlainHttpUrl(url)) {
    if (!warnedBadUrl) {
      warnedBadUrl = true;
      console.warn(
        "[blobs] SUPABASE_URL is not a plain https URL (it looks like a connection string?) — " +
          "Storage disabled; expected https://<project-ref>.supabase.co"
      );
    }
    return null;
  }
  return { url, key };
}

export function blobsEnabled(): boolean {
  return config() !== null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".ndjson": "application/x-ndjson",
};

function contentTypeFor(key: string): string {
  return CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream";
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function publicUrl(key: string): string {
  const c = config();
  if (!c) throw new Error("Supabase Storage is not configured");
  return `${c.url}/storage/v1/object/public/${BUCKET}/${encodeKey(key)}`;
}

let bucketReady: Promise<void> | null = null;

/** Create the public bucket on first use (no-op when it already exists). */
function ensureBucket(): Promise<void> {
  const c = config();
  if (!c) return Promise.resolve();
  bucketReady ??= (async () => {
    const res = await fetch(`${c.url}/storage/v1/bucket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.key}`, apikey: c.key, "Content-Type": "application/json" },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (!/already exists|Duplicate/i.test(body)) {
        throw new Error(`Supabase Storage: cannot create bucket ${BUCKET} (${res.status}): ${body.slice(0, 200)}`);
      }
    }
  })().catch((err) => {
    bucketReady = null;
    throw err;
  });
  return bucketReady;
}

export async function uploadBlob(key: string, body: Buffer | string, contentType = contentTypeFor(key)): Promise<void> {
  const c = config();
  if (!c) throw new Error("Supabase Storage is not configured");
  await ensureBucket();
  const res = await fetch(`${c.url}/storage/v1/object/${BUCKET}/${encodeKey(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.key}`,
      apikey: c.key,
      "Content-Type": contentType,
      "x-upsert": "true",
      "Cache-Control": key.startsWith("audio/") ? "max-age=31536000" : "max-age=3600",
    },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase Storage upload ${key} failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Public screenshot files only — never the verifier's scripts, probes or notes. */
export const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/** Upload every file under `localDir` (matching `filter`) to `prefix/…`. Returns the number of files. */
export async function uploadDir(localDir: string, prefix: string, filter: RegExp = IMAGE_FILE): Promise<number> {
  if (!existsSync(localDir)) return 0;
  let n = 0;
  for (const entry of await readdir(localDir, { withFileTypes: true })) {
    const local = path.join(localDir, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      n += await uploadDir(local, key, filter);
    } else if (entry.isFile() && filter.test(entry.name)) {
      await uploadBlob(key, await readFile(local));
      n++;
    }
  }
  return n;
}

export async function blobExists(key: string): Promise<boolean> {
  if (!blobsEnabled()) return false;
  const res = await fetch(publicUrl(key), { method: "HEAD" });
  return res.ok;
}

export async function fetchBlobText(key: string): Promise<string | null> {
  if (!blobsEnabled()) return null;
  const res = await fetch(publicUrl(key));
  return res.ok ? res.text() : null;
}
