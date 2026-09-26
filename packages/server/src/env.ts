// env.ts — load the root .env before any other module reads process.env.
// Imported first in index.ts; ESM evaluates imports in order.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
