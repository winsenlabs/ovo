'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isRoutingDisabled } from './routing-api';

export type Load<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

/**
 * Load a routing resource: loading, ready, `disabled` (the feature is off, not an error) or
 * error with a reload. `deps` re-run it; a response that arrives after a newer request, or after
 * unmount, is dropped.
 */
export function useRoutingLoad<T>(load: () => Promise<T>, deps: readonly unknown[] = []) {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const generation = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const data = await loader.current();
      if (generation.current === request) setState({ status: 'ready', data });
    } catch (failure) {
      if (generation.current !== request) return;
      setState(
        isRoutingDisabled(failure)
          ? { status: 'disabled' }
          : {
              status: 'error',
              message: failure instanceof Error ? failure.message : 'Could not be loaded.',
            },
      );
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { state, reload, setState };
}
