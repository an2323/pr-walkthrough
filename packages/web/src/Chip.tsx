import type { SourceTag } from '@pr-walkthrough/shared';

const TAG_LABEL: Record<SourceTag, string> = {
  fact: 'Fact',
  commit_history: 'From commits',
  inferred: 'Inferred',
  unverified: 'Not verified',
};

interface Props {
  tag: SourceTag;
}

export function Chip({ tag }: Props) {
  return (
    <span className={`chip t-${tag}`}>{TAG_LABEL[tag]}</span>
  );
}
