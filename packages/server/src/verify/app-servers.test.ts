import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cloneDirArgs, ensureInstalled, startApp } from "./app-servers.js";
import type { AppRecipe } from "./recipes.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), "app-servers-"));
  dirs.push(d);
  return d;
};

/** A recipe whose "install" is a tiny node script — no network, no yarn. */
function fakeRecipe(overrides: Partial<AppRecipe> = {}): AppRecipe {
  return {
    repo: "acme/widgets",
    installedMarker: "node_modules/.marker",
    lockfile: "lock.txt",
    install: {
      cmd: process.execPath,
      args: ["-e", 'const fs=require("fs");fs.mkdirSync("node_modules",{recursive:true});fs.writeFileSync("node_modules/.marker","1");fs.appendFileSync("install-runs.txt","x")'],
    },
    start: (port) => ({
      cmd: process.execPath,
      args: ["-e", `require("http").createServer((q,r)=>r.end("ok")).listen(${port},"127.0.0.1")`],
      env: {},
    }),
    viewport: { width: 1280, height: 800 },
    hints: "",
    ...overrides,
  };
}

describe("cloneDirArgs", () => {
  it("uses an APFS clone on macOS", () => {
    expect(cloneDirArgs("darwin", "/a/node_modules", "/b/node_modules")).toEqual(["-cR", "/a/node_modules", "/b/node_modules"]);
  });

  it("never passes the macOS-only -c flag on Linux (the deploy VM)", () => {
    const args = cloneDirArgs("linux", "/a/node_modules", "/b/node_modules");
    expect(args).toEqual(["-a", "--reflink=auto", "/a/node_modules", "/b/node_modules"]);
    expect(args).not.toContain("-cR");
  });
});

describe("ensureInstalled", () => {
  it("returns 'ready' without running anything when the marker exists", async () => {
    const wt = await tmp();
    await mkdir(path.join(wt, "node_modules"));
    await writeFile(path.join(wt, "node_modules/.marker"), "1");
    expect(await ensureInstalled(fakeRecipe(), wt)).toBe("ready");
    expect(existsSync(path.join(wt, "install-runs.txt"))).toBe(false);
  });

  it("installs from scratch when there is no donor", async () => {
    const root = await tmp();
    const wt = path.join(root, "wt-a");
    await mkdir(wt);
    expect(await ensureInstalled(fakeRecipe(), wt, { minFreeBytes: 1 })).toBe("installed");
    expect(existsSync(path.join(wt, "node_modules/.marker"))).toBe(true);
  });

  it("copies node_modules from an explicit donor, then reconciles with the recipe's install", async () => {
    const root = await tmp();
    const donor = path.join(root, "wt-base");
    const wt = path.join(root, "wt-head");
    await mkdir(path.join(donor, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(donor, "node_modules/.marker"), "1");
    await writeFile(path.join(donor, "node_modules/pkg/index.js"), "module.exports = 1");
    await mkdir(wt);

    expect(await ensureInstalled(fakeRecipe(), wt, { donor, minFreeBytes: 1 })).toBe("cloned");
    expect(await readFile(path.join(wt, "node_modules/pkg/index.js"), "utf-8")).toBe("module.exports = 1");
  });

  it("finds an installed sibling as donor on its own", async () => {
    const root = await tmp();
    const sibling = path.join(root, "wt-sibling");
    const wt = path.join(root, "wt-new");
    await mkdir(path.join(sibling, "node_modules"), { recursive: true });
    await writeFile(path.join(sibling, "node_modules/.marker"), "1");
    await mkdir(wt);
    expect(await ensureInstalled(fakeRecipe(), wt, { minFreeBytes: 1 })).toBe("cloned");
  });

  it("wipes a half-finished install (no marker) before starting", async () => {
    const root = await tmp();
    const wt = path.join(root, "wt-a");
    await mkdir(path.join(wt, "node_modules/leftover"), { recursive: true });
    await writeFile(path.join(wt, "node_modules/leftover/file"), "partial");
    await ensureInstalled(fakeRecipe(), wt, { minFreeBytes: 1 });
    expect(existsSync(path.join(wt, "node_modules/leftover"))).toBe(false);
    expect(existsSync(path.join(wt, "node_modules/.marker"))).toBe(true);
  });

  it("refuses, with numbers, when there isn't enough free space", async () => {
    const wt = await tmp();
    await expect(ensureInstalled(fakeRecipe(), wt, { minFreeBytes: 1e18 })).rejects.toThrow(/GB free — need/);
  });

  it("keeps the tail of stderr when the install fails, and kills the whole group on timeout", async () => {
    const wt = await tmp();
    const failing = fakeRecipe({ install: { cmd: process.execPath, args: ["-e", 'console.error("boom: registry unreachable");process.exit(3)'] } });
    await expect(ensureInstalled(failing, wt, { minFreeBytes: 1 })).rejects.toThrow(/exited 3.*boom: registry unreachable/s);

    const wt2 = await tmp();
    const hanging = fakeRecipe({ install: { cmd: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } });
    await expect(ensureInstalled(hanging, wt2, { minFreeBytes: 1, timeoutMs: 700 })).rejects.toThrow(/timed out after/);
  }, 15_000);
});

describe("startApp", () => {
  it("starts a dev server, answers on its port, and stops it", async () => {
    const wt = await tmp();
    const app = await startApp(fakeRecipe(), wt, 15_000);
    try {
      const res = await fetch(app.url);
      expect(await res.text()).toBe("ok");
    } finally {
      await app.stop();
    }
    await expect(fetch(app.url, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
  }, 20_000);

  it("reports the dev server's own output when it dies early", async () => {
    const wt = await tmp();
    const dying = fakeRecipe({ start: () => ({ cmd: process.execPath, args: ["-e", 'console.error("EADDRINUSE: cannot bind");process.exit(1)'], env: {} }) });
    await expect(startApp(dying, wt, 15_000)).rejects.toThrow(/exited early \(code 1\).*EADDRINUSE/s);
  }, 20_000);

  it("turns a missing executable into an error instead of crashing the process", async () => {
    const wt = await tmp();
    const missing = fakeRecipe({ start: () => ({ cmd: "definitely-not-a-real-binary-xyz", args: [], env: {} }) });
    await expect(startApp(missing, wt, 15_000)).rejects.toThrow(/could not start|exited early|ENOENT/);
  }, 20_000);

  it("gives up with the output tail when the server never answers", async () => {
    const wt = await tmp();
    const silent = fakeRecipe({ start: () => ({ cmd: process.execPath, args: ["-e", 'console.log("compiling...");setInterval(()=>{},1000)'], env: {} }) });
    await expect(startApp(silent, wt, 1500)).rejects.toThrow(/Timed out waiting for .*compiling/s);
  }, 20_000);
});
