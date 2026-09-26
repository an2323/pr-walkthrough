import { useState, useEffect } from 'react';
import type { Walkthrough } from '@pr-walkthrough/shared';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: Walkthrough }
  | { status: 'error'; message: string };

export function useWalkthrough(): State {
  const [state, setState] = useState<State>({ status: 'idle' });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const localPath = params.get('local');
    if (!localPath) {
      setState({ status: 'idle' });
      return;
    }

    setState({ status: 'loading' });

    fetch(localPath)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${localPath}`);
        return res.json();
      })
      .then((data: Walkthrough) => setState({ status: 'ok', data }))
      .catch((err: unknown) =>
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      );
  }, []);

  return state;
}
