import { describe, expect, it } from 'vitest';
import { parsePRUrl } from './prUrl';

describe('parsePRUrl', () => {
  it('reads a full PR URL, with or without a trailing slash or extra path', () => {
    expect(parsePRUrl('https://github.com/excalidraw/excalidraw/pull/10295')).toEqual({ owner: 'excalidraw', repo: 'excalidraw', number: 10295 });
    expect(parsePRUrl('https://github.com/a/b/pull/7/')).toEqual({ owner: 'a', repo: 'b', number: 7 });
    expect(parsePRUrl('https://github.com/a/b/pull/7/files')).toEqual({ owner: 'a', repo: 'b', number: 7 });
    expect(parsePRUrl('  github.com/a/b/pull/7  ')).toEqual({ owner: 'a', repo: 'b', number: 7 });
  });
  it('reads the short form owner/repo#123', () => {
    expect(parsePRUrl('an2323/excalidraw#21')).toEqual({ owner: 'an2323', repo: 'excalidraw', number: 21 });
  });
  it('rejects anything that is not a pull request', () => {
    for (const s of ['', 'hello', 'https://github.com/a/b', 'https://github.com/a/b/issues/3', 'a/b', '#12']) expect(parsePRUrl(s)).toBeNull();
  });
});
