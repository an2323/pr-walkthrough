// packages/server/src/index.ts — Express entry point
import "./env.js"; // must stay first
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import apiRouter from "./api/routes.js";

const app = express();
const port = process.env.PORT ?? 3000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// CORS — allow the Vite dev server (default port 5173) and any localhost origin.
app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
app.use("/data/shots", express.static(path.join(ROOT, "data/shots"), { fallthrough: false, maxAge: "1h" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", apiRouter);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}  [ANALYZER=${process.env.ANALYZER ?? "cached"}]`);
});
