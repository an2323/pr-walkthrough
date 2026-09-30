// packages/server/src/index.ts — Express entry point
import "./env.js"; // must stay first
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import apiRouter from "./api/routes.js";
import { corsAllowed } from "./api/cors.js";
import { findActiveJob } from "./api/jobs.js";
import { failStaleJobRows } from "./storage.js";
import { ensureSchema, startKeepAlive, databaseUrl } from "./db.js";
import { blobExists, blobsEnabled, publicUrl } from "./blobs.js";

const app = express();
const port = process.env.PORT ?? 3000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Behind Caddy in production: trust X-Forwarded-* for req.protocol / req.ip.
app.set("trust proxy", true);

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (corsAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Access-Code");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());

// Before/after screenshots (same URLs as the VITE_STATIC build). Only data/shots is
// public: data/runs holds raw Bob transcripts and prompts, which stay server-side.
// Local disk first; otherwise the copy in Supabase Storage.
app.use("/data/shots", express.static(path.join(ROOT, "data/shots"), { maxAge: "1h" }));
app.use("/data/shots", async (req: Request, res: Response): Promise<void> => {
  const rel = path.posix.normalize(decodeURIComponent(req.path)).replace(/^\/+/, "");
  if (!rel || rel.startsWith("..") || !blobsEnabled()) {
    res.sendStatus(404);
    return;
  }
  const key = `shots/${rel}`;
  if (!existsSync(path.join(ROOT, "data/shots", rel)) && (await blobExists(key))) {
    res.redirect(302, publicUrl(key));
    return;
  }
  res.sendStatus(404);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    analyzer: process.env.ANALYZER ?? "cached",
    database: Boolean(databaseUrl()),
    storage: blobsEnabled(),
    // deploy.sh refuses to recreate the container while a paid run is in flight.
    activeJob: findActiveJob() !== undefined,
  });
});

app.use("/api", apiRouter);

// Express 5 forwards rejected async handlers here instead of crashing the process.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[server] unhandled route error:", err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (err) => {
  console.error("[server] unhandled rejection:", err);
});

async function main(): Promise<void> {
  if (databaseUrl()) {
    // A paused or unreachable database must not crash-loop the whole service (health,
    // screenshots, the viewer): every DB helper retries its own schema setup on first use.
    try {
      await ensureSchema();
      const stale = await failStaleJobRows();
      if (stale > 0) console.log(`[server] marked ${stale} interrupted job(s) as failed (server restarted)`);
    } catch (err) {
      console.error("[server] database not ready at startup — continuing without it:", err instanceof Error ? err.message : err);
    }
    startKeepAlive();
  }
  app.listen(port, () => {
    console.log(
      `Server running on http://localhost:${port}  [ANALYZER=${process.env.ANALYZER ?? "cached"}]` +
        (databaseUrl() ? " [db=postgres]" : " [db=files]") +
        (blobsEnabled() ? " [storage=supabase]" : " [storage=disk]")
    );
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
