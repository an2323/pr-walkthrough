import { describe, it, expect, afterEach, vi } from "vitest";

import { blobsEnabled, isPlainHttpUrl } from "./blobs.js";

describe("isPlainHttpUrl", () => {
  it("accepts a project API URL", () => {
    expect(isPlainHttpUrl("https://abcdefgh.supabase.co")).toBe(true);
    expect(isPlainHttpUrl("http://localhost:54321")).toBe(true);
  });

  it("rejects a database connection string and anything with credentials", () => {
    expect(isPlainHttpUrl("postgresql://postgres:secret@db.abcdefgh.supabase.co:5432/postgres")).toBe(false);
    expect(isPlainHttpUrl("https://user:pass@abcdefgh.supabase.co")).toBe(false);
    expect(isPlainHttpUrl("not a url")).toBe(false);
  });
});

describe("blobsEnabled", () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  afterEach(() => {
    process.env.SUPABASE_URL = saved.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("stays off — and never logs the value — when SUPABASE_URL is a connection string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SUPABASE_URL = "postgresql://postgres:hunter2@db.abcdefgh.supabase.co:5432/postgres";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    expect(blobsEnabled()).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/hunter2|postgresql:\/\//);
    warn.mockRestore();
  });

  it("turns on with a real project URL", () => {
    process.env.SUPABASE_URL = "https://abcdefgh.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    expect(blobsEnabled()).toBe(true);
  });
});
