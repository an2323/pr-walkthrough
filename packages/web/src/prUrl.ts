/** Parse what people paste into the landing input: a PR URL, or "owner/repo#123". */
export function parsePRUrl(raw: string): { owner: string; repo: string; number: number } | null {
  const trimmed = raw.trim().replace(/\/$/, '');
  const m = trimmed.match(/(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (m) return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
  const s = trimmed.match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/);
  if (s) return { owner: s[1], repo: s[2], number: parseInt(s[3], 10) };
  return null;
}
