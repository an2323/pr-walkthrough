import { describe, expect, it } from "vitest";

import { checkVerbatim, nearestLine } from "./verbatim.js";

// DropdownMenuContent.tsx around the #12053 change (HEAD).
const HEAD = [
  "  useEffect(() => {",
  "    if (!menuNode) return;",
  "  }, [callbacksRef, open, menuNode]);",
  "  }, [open]);",
  "  return null;",
].join("\n");
const BASE = HEAD.replace("}, [callbacksRef, open, menuNode]);", "}, [callbacksRef, open]);");

describe("nearestLine", () => {
  it("fixes the one-character quote Bob made on the live #12053 run", () => {
    expect(nearestLine("  }, [callbacksRef, open, menuNode];", HEAD.split("\n"))).toBe("  }, [callbacksRef, open, menuNode]);");
  });

  it("never picks between two equally close lines", () => {
    expect(nearestLine("  }, [a];", ["  }, [a]);", "  }, [b];"])).toBeUndefined();
  });

  it("never changes the indentation or accepts a real difference", () => {
    expect(nearestLine("}, [callbacksRef, open, menuNode];", HEAD.split("\n"))).toBeUndefined();
    expect(nearestLine("  }, [callbacksRef];", HEAD.split("\n"))).toBeUndefined();
  });
});

describe("checkVerbatim corrects near-misses in place", () => {
  it("both live #12053 errors (base and diff) are corrected and the draft passes", async () => {
    const draft = {
      steps: [
        {
          id: "s6",
          beats: [
            { code: [{ file: "Dropdown.tsx", revision: "base", lines: [{ kind: "context", text: "  }, [callbacksRef, open];" }] }] },
            { code: [{ file: "Dropdown.tsx", revision: "diff", lines: [{ kind: "added", text: "  }, [callbacksRef, open, menuNode];" }] }] },
          ],
        },
      ],
    } as never;
    const ws = { readFile: async (_f: string, rev: "base" | "head") => (rev === "base" ? BASE : HEAD) } as never;
    const r = await checkVerbatim(draft, ws);
    expect(r.errors).toEqual([]);
    expect(r.snapped).toHaveLength(2);
    const d = draft as unknown as { steps: { beats: { code: { lines: { text: string }[] }[] }[] }[] };
    expect(d.steps[0].beats[1].code[0].lines[0].text).toBe("  }, [callbacksRef, open, menuNode]);");
  });
});

describe("checkVerbatim relabels a block quoted from the other revision", () => {
  it("a block marked head whose lines exist only at base becomes a base block (#12053)", async () => {
    const draft = {
      steps: [{ id: "s5", beats: [{ code: [{ file: "Dropdown.tsx", revision: "head", lines: [{ kind: "context", text: "  }, [callbacksRef, open]);" }] }] }] }],
    } as never;
    const ws = { readFile: async (_f: string, rev: "base" | "head") => (rev === "base" ? BASE : HEAD) } as never;
    const r = await checkVerbatim(draft, ws);
    expect(r.errors).toEqual([]);
    const d = draft as unknown as { steps: { beats: { code: { revision: string }[] }[] }[] };
    expect(d.steps[0].beats[0].code[0].revision).toBe("base");
  });

  it("a block mixing lines from both revisions is not relabelled", async () => {
    const draft = {
      steps: [{ id: "s5", beats: [{ code: [{ file: "D.tsx", revision: "head", lines: [{ kind: "context", text: "  }, [callbacksRef, open]);" }, { kind: "context", text: "  }, [callbacksRef, open, menuNode]);" }] }] }] }],
    } as never;
    const ws = { readFile: async (_f: string, rev: "base" | "head") => (rev === "base" ? BASE : HEAD) } as never;
    const r = await checkVerbatim(draft, ws);
    const d = draft as unknown as { steps: { beats: { code: { revision: string }[] }[] }[] };
    expect(d.steps[0].beats[0].code[0].revision).toBe("head");
    expect(r.errors.length + r.snapped.length).toBeGreaterThan(0);
  });
});

describe("checkVerbatim relabels a diff-shaped block", () => {
  it("removed+added lines labelled head become a diff block (#12053 s5)", async () => {
    const draft = {
      steps: [{ id: "s5", beats: [{ code: [{ file: "D.tsx", revision: "head", lines: [
        { kind: "removed", text: "  }, [callbacksRef, open]);" },
        { kind: "added", text: "  }, [callbacksRef, open, menuNode]);" },
        { kind: "context", text: "  return null;" },
      ] }] }] }],
    } as never;
    const ws = { readFile: async (_f: string, rev: "base" | "head") => (rev === "base" ? BASE : HEAD) } as never;
    const r = await checkVerbatim(draft, ws);
    expect(r.errors).toEqual([]);
    const d = draft as unknown as { steps: { beats: { code: { revision: string }[] }[] }[] };
    expect(d.steps[0].beats[0].code[0].revision).toBe("diff");
  });
});

