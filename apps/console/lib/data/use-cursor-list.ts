'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { apiRequest } from '../api';

export type CursorPage<T> = { items: T[]; nextCursor?: string | null };
export function appendPageQuery(path: string, cursor?: string, limit = 50): string {
  const [base, search = ''] = path.split('?');
  const params = new URLSearchParams(search);
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor); else params.delete('cursor');
  return `${base}?${params}`;
}
export function useCursorList<T>(path: string, limit = 50) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const cursor = search.get('cursor') ?? undefined;
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [page, setPage] = useState<CursorPage<T>>({ items: [] });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const endpoint = useMemo(() => appendPageQuery(path, cursor, limit), [path, cursor, limit]);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setPage({ items: [] }); setStatus('loading'); setError(undefined);
    try {
      const { data } = await apiRequest<CursorPage<T>>(endpoint);
      if (generation.current !== request) return;
      setPage(data); setStatus('ready');
    } catch (failure) {
      if (generation.current !== request) return;
      setPage({ items: [] }); setError(failure instanceof Error ? failure.message : 'List unavailable'); setStatus('error');
    }
  }, [endpoint]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const navigate = (next?: string) => {
    const params = new URLSearchParams(search.toString());
    if (next) params.set('cursor', next); else params.delete('cursor');
    router.push(`${pathname}${params.size ? `?${params}` : ''}`);
  };
  return {
    ...page, status, error, refresh: load,
    hasPrevious: history.length > 0,
    hasNext: Boolean(page.nextCursor),
    next: () => { if (page.nextCursor) { setHistory(current => [...current, cursor]); navigate(page.nextCursor); } },
    previous: () => { if (!history.length) return; const previous = history.at(-1); setHistory(current => current.slice(0, -1)); navigate(previous); },
    reset: () => { setHistory([]); navigate(undefined); },
  };
}
