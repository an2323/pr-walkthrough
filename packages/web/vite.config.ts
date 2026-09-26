import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_STATIC=1: public demo build. public/ is skipped because it holds the Outline
// example, whose licence is unverified — the demo's /data/ is written by export-static.
const isStatic = process.env.VITE_STATIC === "1";

export default defineConfig({
  plugins: [react()],
  publicDir: isStatic ? false : "public",
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.API_TARGET ?? "http://localhost:3000",
      "/data": process.env.API_TARGET ?? "http://localhost:3000",
    },
  },
});
