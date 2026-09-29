/**
 * json-repair.ts — recover a JSON object the model wrote almost correctly.
 *
 * A long walkthrough is prose-heavy JSON, and the most common way it breaks is a
 * double quote inside a string ("checks "did the click land inside?" and skips…").
 * `JSON.parse` then fails at every start position, and a $3 analysis is thrown
 * away for one missing backslash. Repairing it locally is free and deterministic.
 *
 * Repairs (only when strict parsing already failed):
 *   - unescaped `"` inside a string   → `\"`
 *   - raw newline / tab in a string   → `\n` / `\t`
 *   - trailing comma before } or ]
 *
 * The quote rule is a heuristic: a `"` inside a string closes it only when what
 * follows makes sense structurally (`:` for a key; `,` + the start of another
 * value, `}` or `]` for a value). Anything else is prose, so the quote is escaped.
 * Callers still validate the parsed result (schema, predicate) — a wrong guess
 * can only produce something that fails those checks, never silently wrong data.
 */

const VALUE_START = /^(?:["{[\-0-9]|true\b|false\b|null\b)/;

function nextSignificant(text: string, from: number): { ch: string; rest: string; idx: number } {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return { ch: text[i] ?? "", rest: text.slice(i, i + 6), idx: i };
}

/**
 * Returns the repaired text of the balanced object starting at `text[start]`
 * (which must be `{`), or undefined if it never closes.
 */
export function repairJsonObject(text: string, start: number): string | undefined {
  if (text[start] !== "{") return undefined;

  const out: string[] = [];
  const stack: ("obj" | "arr")[] = [];
  let inStr = false;
  let isKey = false;
  let expectKey = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];

    if (inStr) {
      if (c === "\\") {
        out.push(c, text[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === "\n") { out.push("\\n"); continue; }
      if (c === "\r") { out.push("\\r"); continue; }
      if (c === "\t") { out.push("\\t"); continue; }
      if (c === '"') {
        const { ch, idx } = nextSignificant(text, i + 1);
        let closes: boolean;
        if (isKey) {
          closes = ch === ":";
        } else if (ch === "," ) {
          const after = nextSignificant(text, idx + 1);
          closes = VALUE_START.test(after.rest) || (stack[stack.length - 1] === "obj" && after.ch === '"');
        } else {
          closes = ch === "}" || ch === "]" || ch === "";
        }
        if (closes) {
          inStr = false;
          out.push(c);
        } else {
          out.push('\\"');
        }
        continue;
      }
      out.push(c);
      continue;
    }

    if (c === '"') {
      inStr = true;
      isKey = expectKey;
      expectKey = false;
      out.push(c);
      continue;
    }
    if (c === "{") {
      stack.push("obj");
      expectKey = true;
      out.push(c);
      continue;
    }
    if (c === "[") {
      stack.push("arr");
      expectKey = false;
      out.push(c);
      continue;
    }
    if (c === "}" || c === "]") {
      // Trailing comma: drop it (and any whitespace before it).
      let j = out.length - 1;
      while (j >= 0 && /^\s+$/.test(out[j])) j--;
      if (j >= 0 && out[j] === ",") out.splice(j, 1);
      stack.pop();
      expectKey = false;
      out.push(c);
      if (stack.length === 0) return out.join("");
      continue;
    }
    if (c === ",") {
      expectKey = stack[stack.length - 1] === "obj";
      out.push(c);
      continue;
    }
    out.push(c);
  }
  return undefined;
}

/** Try to parse the object starting at `start`, repairing it first. */
export function parseRepairedJsonObject(text: string, start: number): unknown | undefined {
  const repaired = repairJsonObject(text, start);
  if (repaired === undefined) return undefined;
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}
