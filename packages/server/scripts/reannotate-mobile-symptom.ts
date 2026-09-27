/**
 * One-off: redraw symptom-menu-under-sidebar-mobile.png with labels only (no boxes).
 *   pnpm --filter @pr-walkthrough/server exec tsx scripts/reannotate-mobile-symptom.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { annotateShot } from "../src/shots/annotate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(ROOT, "data/shots/excalidraw/excalidraw/10295");
const raw = path.join(dir, "symptom-menu-under-sidebar-mobile-raw.png");
const out = path.join(dir, "symptom-menu-under-sidebar-mobile.png");

await annotateShot(
  raw,
  out,
  [
    { x: 0, y: 0, w: 1, h: 0.048, label: "Mobile · sidebar covers the open menu" },
    { x: 0.2, y: 0.11, w: 0.01, h: 0.01, label: "Sidebar on top" },
    { x: 0.03, y: 0.4, w: 0.01, h: 0.01, label: "Main menu (under)" },
  ],
  "bad",
  { labelsOnly: true }
);
console.log("wrote", out);
