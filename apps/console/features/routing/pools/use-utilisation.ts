'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { routingApi } from '../../../lib/data/routing-api';
import type { PoolUtilisation } from '../../../lib/types/routing';

export const UTILISATION_POLL_MS = 10_000;

/**
 * A pool's live claims, polled while the tab is visible. A failed poll keeps the last numbers and
 * marks them stale (with a retry) so the page stays usable; the first load failing is `unavailable`.
 */
export function useUtilisation(poolId: string, enabled = true) {
  const [data, setData] = useState<PoolUtilisation>();
  const [stale, setStale] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const alive = useRef(true);
  const poll = useCallback(async () => {
    try {
      const next = await routingApi.utilisation(poolId);
      if (!alive.current) return;
      setData(next);
      setStale(false);
      setUnavailable(false);
    } catch {
      if (!alive.current) return;
      setStale(true);
      setUnavailable((was) => was || data === undefined);
    }
  }, [poolId, data]);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    void pollRef.current();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void pollRef.current();
    }, UTILISATION_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [poolId, enabled]);
  return { data, stale, unavailable, retry: () => void poll() };
}
