'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cacheGet, cacheSet, cacheSubscribe } from './cache';
export type ResourceState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: string };
export function useResource<T>(key: string, load: () => Promise<T>, ttlMs = 15_000) {
  const cached = cacheGet<T>(key);
  const [state, setState] = useState<ResourceState<T> & { key: string }>(cached ? { key, status: 'ready', data: cached.value } : { key, status: 'loading' });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setState({ key, status: 'loading' });
    try {
      const data = await load();
      if (generation.current !== request) return;
      cacheSet(key, data);
      setState({ key, status: 'ready', data });
    } catch (error) {
      if (generation.current !== request) return;
      setState({ key, status: 'error', error: error instanceof Error ? error.message : 'Unable to load resource' });
    }
  }, [key, load]);
  useEffect(() => {
    const unsubscribe = cacheSubscribe(key, () => {
      const next = cacheGet<T>(key);
      if (next) setState({ key, status: 'ready', data: next.value });
      else void refresh();
    });
    const previous = cacheGet<T>(key);
    if (!previous || Date.now() - previous.at > ttlMs) void refresh();
    else setState({ key, status: 'ready', data: previous.value });
    return () => { unsubscribe(); generation.current++; };
  }, [key, ttlMs, refresh]);
  return { ...(state.key === key ? state : { status: 'loading' as const }), refresh };
}
