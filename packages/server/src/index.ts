// packages/server/src/index.ts — Express entry point
import "./env.js"; // must stay first
import express from "express";
import apiRouter from "./api/routes.js";

const app = express();
const port = process.env.PORT ?? 3000;

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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", apiRouter);

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}  [ANALYZER=${process.env.ANALYZER ?? "cached"}]`);
});
