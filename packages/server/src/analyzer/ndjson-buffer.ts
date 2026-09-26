/**
 * ndjson-buffer.ts — incremental NDJSON line splitter for streamed process
 * output. `bob run --format stream-json` writes one JSON object per line,
 * but Node delivers stdout in arbitrary-sized chunks that can split a line
 * in the middle (or bundle several lines together) — this buffers the
 * trailing partial line across chunks so callers only ever see whole lines.
 */

/** One line, parsed — or the raw trimmed string if it wasn't valid JSON. */
export type NdjsonLine = unknown;

export class NdjsonBuffer {
  private pending = "";

  /** Feed a chunk of raw text; returns each newly-completed line from it. */
  push(chunk: string): NdjsonLine[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    // The last element is either "" (chunk ended on a newline) or a partial
    // line still waiting for more data — keep it buffered either way.
    this.pending = lines.pop() ?? "";
    return lines.map(parseLine).filter((l): l is NdjsonLine => l !== undefined);
  }

  /** Call once the stream has ended — parses any trailing data with no final newline. */
  flush(): NdjsonLine[] {
    const rest = this.pending;
    this.pending = "";
    const parsed = parseLine(rest);
    return parsed === undefined ? [] : [parsed];
  }
}

function parseLine(line: string): NdjsonLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
