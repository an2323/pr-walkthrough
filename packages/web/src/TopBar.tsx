import type { Walkthrough } from '@pr-walkthrough/shared';
import './TopBar.css';

function md(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/`([^`]+)`/g, '<code>$1</code>');
}

interface Props {
  data: Walkthrough;
}

export function TopBar({ data }: Props) {
  const { pr, summary } = data;
  const stats = `${pr.filesChanged} files changed, +${pr.additions} −${pr.deletions}, ${pr.commitTitles.length} commits`;

  return (
    <header className="top">
      <div className="repo">
        <a href={pr.url}>{pr.repo} #{pr.number}</a> by {pr.author}
      </div>
      <h1>{pr.title}</h1>
      <div className="stats">{stats}</div>
      <div className="summary">
        <div>
          <b>What was broken</b>
          <span dangerouslySetInnerHTML={{ __html: md(summary.problem) }} />
        </div>
        <div>
          <b>The idea of the fix</b>
          <span dangerouslySetInnerHTML={{ __html: md(summary.solution) }} />
        </div>
      </div>
    </header>
  );
}
