/** cors.ts — which browser origins may call the API (the Vercel front end lives on another host). */

/** Localhost always; extra origins via CORS_ORIGINS (comma-separated, or "*"). */
export function corsAllowed(origin: string): boolean {
  if (!origin) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  const raw = process.env.CORS_ORIGINS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  // Entries may use "*" as a wildcard within one origin (Vercel preview URLs:
  // https://pr-walkthrough-*-team.vercel.app).
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((p) => p === origin || (p.includes("*") && new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]*")}$`).test(origin)));
}
