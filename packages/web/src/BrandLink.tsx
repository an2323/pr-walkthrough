/** The product mark + name as a link to the landing page — the way out of any PR view. */
export function BrandLink({ className = 'brandlink' }: { className?: string }) {
  return (
    <a className={className} href="/" title="All walkthroughs — back to the start page" aria-label="PR Walkthrough — home">
      <svg width="24" height="24" viewBox="0 0 30 30" aria-hidden="true">
        <rect x="0.75" y="0.75" width="28.5" height="28.5" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
        <circle cx="10" cy="20" r="2.4" fill="var(--accent)" />
        <circle cx="20" cy="10" r="2.4" fill="var(--good)" />
        <path d="M10 20 L10 13 L20 13 L20 10" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>PR Walkthrough</span>
    </a>
  );
}
