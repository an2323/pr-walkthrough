import type { CodeBlock } from '@pr-walkthrough/shared';
import { Chip } from './Chip';
import type { SourceTag } from '@pr-walkthrough/shared';

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function md(s: string) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

const REVISION_LABEL: Record<string, string> = {
  base: 'before',
  head: 'after',
  diff: 'change',
};

const LINE_GUTTER: Record<string, string> = {
  added: '+',
  removed: '−',
  focus: '›',
  elided: '',
  context: '',
};

interface Props {
  block: CodeBlock;
}

export function CodeBlockView({ block }: Props) {
  const revLabel = block.label ?? REVISION_LABEL[block.revision] ?? block.revision;

  return (
    <div className={`code${block.reconstructed ? ' rec' : ''}`}>
      <div className="fh">
        <span>{block.file}</span>
        <span>{revLabel}</span>
      </div>
      <div className="body">
        {block.lines.map((line, i) => (
          <div key={i}>
            <div className={`ln ${line.kind}`}>
              <span className="g">{LINE_GUTTER[line.kind] ?? ''}</span>
              <span className="tx">{line.text || ' '}</span>
            </div>
            {line.annotation && (
              <div className="ann">
                <span dangerouslySetInnerHTML={{ __html: '↳ ' + md(line.annotation) }} />
                {line.annotationTag && line.annotationTag !== 'fact' && (
                  <Chip tag={line.annotationTag as SourceTag} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
