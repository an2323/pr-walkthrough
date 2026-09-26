import { useState, useEffect } from 'react';
import type { Walkthrough } from '@pr-walkthrough/shared';
import { walkthroughUrl } from './staticMode';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: Walkthrough }
  | { status: 'error'; message: string };

/**
 * Loads a Walkthrough from either:
 *  - ?local=/path.json  → fetch the file directly (dev/local use)
 *  - /:owner/:repo/:number  → fetch from /api/walkthroughs/:owner/:repo/:number
 */
export function useWalkthrough(): State {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const localPath = params.get('local');

    let url: string | null = null;

    if (localPath) {
      // ?local=/foo.json
      url = localPath;
    } else {
      // Try to match /:owner/:repo/:number from the pathname
      const match = window.location.pathname.match(
        /^\/([^/]+)\/([^/]+)\/(\d+)\/?$/
      );
      if (match) {
        const [, owner, repo, number] = match;
        url = walkthroughUrl(owner, repo, parseInt(number, 10));
      }
    }

    if (!url) {
      setState({ status: 'idle' });
      return;
    }

    setState({ status: 'loading' });

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        return res.json();
      })
      .then((data: Walkthrough) => setState({ status: 'ok', data }))
      .catch((err: unknown) =>
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      );
  }, []);

  return state;
}
