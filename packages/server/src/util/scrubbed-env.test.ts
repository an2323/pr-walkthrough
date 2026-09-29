import { describe, it, expect, afterEach } from "vitest";

import { ENV_KEEP, scrubbedEnv } from "./scrubbed-env.js";

describe("scrubbedEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it("passes through what a build needs and nothing else", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/root";
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/pw";
    process.env.DATABASE_URL = "postgresql://u:secret@h/db";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srk";
    process.env.BOB_API_KEY = "bob";
    process.env.GITHUB_TOKEN_WRITE = "ghp";
    process.env.ELEVENLABS_API_KEY = "el";

    const env = scrubbedEnv();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/root");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/pw");
    for (const secret of ["DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BOB_API_KEY", "GITHUB_TOKEN_WRITE", "ELEVENLABS_API_KEY"]) {
      expect(env[secret]).toBeUndefined();
    }
    expect(Object.keys(env).every((k) => (ENV_KEEP as readonly string[]).includes(k))).toBe(true);
  });

  it("adds only the explicitly requested extras", () => {
    process.env.DATABASE_URL = "x";
    const env = scrubbedEnv({ BOB_API_KEY: "k", HUSKY: "0" });
    expect(env.BOB_API_KEY).toBe("k");
    expect(env.HUSKY).toBe("0");
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("never keeps a variable that looks like a secret", () => {
    expect(ENV_KEEP.some((k) => /KEY|TOKEN|SECRET|PASSWORD|DATABASE/i.test(k))).toBe(false);
  });
});
