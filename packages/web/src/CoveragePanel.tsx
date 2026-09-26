import type { Hunk, SkippedHunk, Step } from '@pr-walkthrough/shared';

interface Props {
  hunks: Hunk[];
  skippedHunks: SkippedHunk[];
  steps: Step[];
}

export function CoveragePanel({ hunks, skippedHunks, steps }: Props) {
  // Build a map: hunkId → step numbers that reference it
  const ref: Record<string, number[]> = {};
  steps.forEach((step, j) => {
    step.hunkIds.forEach((hid) => {
      (ref[hid] = ref[hid] ?? []).push(j + 1);
    });
  });

  const skippedMap = Object.fromEntries(skippedHunks.map((x) => [x.hunkId, x.reason]));

  let uncoveredCount = 0;

  const rows = hunks.map((h) => {
    let statusEl: React.ReactNode;
    if (ref[h.id]) {
      statusEl = <span>steps {ref[h.id].join(', ')}</span>;
    } else if (skippedMap[h.id]) {
      statusEl = <span>skipped: {skippedMap[h.id]}</span>;
    } else {
      uncoveredCount++;
      statusEl = <span className="warn">not explained</span>;
    }
    const shortId = h.id.split('/').pop() ?? h.id;
    return (
      <div key={h.id} className="hk">
        <span className="f" title={h.id}>{shortId}</span>
        <span className="s">{statusEl}</span>
      </div>
    );
  });

  const accounted = hunks.length - uncoveredCount;
  const title = `Diff coverage: ${accounted} of ${hunks.length} hunks accounted for`;

  return (
    <div className="panel">
      <h4>{title}</h4>
      {rows}
    </div>
  );
}
