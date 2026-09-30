import { describe, expect, it } from "vitest";

import { anchorQuotes, locate } from "./anchor.js";

// DropdownMenuContent.tsx around the #12053 change.
const HEAD = [
  "  const [menuNode, setMenuNode] = useCallbackRefState<HTMLDivElement>();",
  "  const menuRef = useMemo(() => ({ current: menuNode }), [menuNode]);",
  "  useEffect(() => {",
  "  }, [callbacksRef, open, menuNode]);",
  "        ref={setMenuNode}",
].join("\n");
const BASE = [
  "  const menuRef = useRef<HTMLDivElement>(null);",
  "  useEffect(() => {",
  "  }, [callbacksRef, open]);",
  "        ref={menuRef}",
].join("\n");
const ws = { readFile: async (_f: string, rev: "base" | "head") => (rev === "base" ? BASE : HEAD) } as never;
const draftOf = (code: unknown[]) => ({ steps: [{ id: "s5", notes: [] as string[], beats: [{ code }] }] }) as never;
const code = (d: unknown) => (d as { steps: { beats: { code?: { revision: string; lines: { kind: string; text: string; annotation?: string }[] }[] }[]; notes: string[] }[] }).steps[0];

describe("locate", () => {
  it("finds the real line for Bob's one-character slip, and nothing for a real difference", () => {
    const f = HEAD.split("\n");
    expect(locate("  }, [callbacksRef, open, menuNode];", f)).toBe(3);
    expect(locate("  }, [callbacksRef];", f)).toBeUndefined();
  });
});

describe("anchorQuotes", () => {
  it("replaces a near-miss with the real line and keeps Bob's annotation on it", async () => {
    const d = draftOf([{ file: "D.tsx", revision: "head", lines: [{ kind: "focus", text: "  }, [callbacksRef, open, menuNode];", annotation: "Rebinds when the node mounts." }] }]);
    const r = await anchorQuotes(d, ws);
    expect(r.corrected).toHaveLength(1);
    expect(code(d).beats[0].code![0].lines[0]).toEqual({ kind: "focus", text: "  }, [callbacksRef, open, menuNode]);", annotation: "Rebinds when the node mounts." });
  });

  it("never shows BASE code as HEAD: a head block of base-only lines is dropped, its annotations kept as notes", async () => {
    const d = draftOf([{ file: "D.tsx", revision: "head", lines: [
      { kind: "context", text: "  const menuRef = useRef<HTMLDivElement>(null);", annotation: "The old ref." },
      { kind: "context", text: "        ref={menuRef}" },
    ] }]);
    const r = await anchorQuotes(d, ws);
    expect(r.dropped).toHaveLength(1);
    expect(code(d).beats[0].code).toBeUndefined();
    expect(code(d).notes).toEqual(["The old ref."]);
  });

  it("removed/added lines are a diff: removed from BASE, added from HEAD (#12053 s5)", async () => {
    const d = draftOf([{ file: "D.tsx", revision: "head", lines: [
      { kind: "removed", text: "  const menuRef = useRef<HTMLDivElement>(null);" },
      { kind: "added", text: "  const [menuNode, setMenuNode] = useCallbackRefState<HTMLDivElement>();" },
      { kind: "focus", text: "  const menuRef = useMemo(() => ({ current: menuNode }), [menuNode]);" },
    ] }]);
    const r = await anchorQuotes(d, ws);
    expect(r.elided).toEqual([]);
    expect(code(d).beats[0].code![0].revision).toBe("diff");
  });

  it("an invented line in an otherwise real block becomes '…'", async () => {
    const d = draftOf([{ file: "D.tsx", revision: "head", lines: [
      { kind: "context", text: "  useEffect(() => {" },
      { kind: "context", text: "  somethingBobMadeUp();" },
      { kind: "context", text: "  }, [callbacksRef, open, menuNode]);" },
    ] }]);
    const r = await anchorQuotes(d, ws);
    expect(r.elided).toHaveLength(1);
    expect(code(d).beats[0].code![0].lines.map((l) => l.text)).toEqual(["  useEffect(() => {", "…", "  }, [callbacksRef, open, menuNode]);"]);
  });
});
