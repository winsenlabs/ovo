'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError, items } from '../api';

/**
 * A failed request's one-line message: a 503 gets the screen's own "not configured" wording
 * (when it supplies one), any other `Error` keeps its own message, and anything else falls back
 * to a generic line. Shared by `useApiList` below and by hand-rolled loaders (e.g. Inbound's
 * policy panel, which combines two endpoints `useApiList`'s single-path shape does not fit) so
 * every screen's 503-aware catch block reads this once instead of re-deriving the same ternary.
 */
export function apiFailureMessage(
  failure: unknown,
  unavailableMessage: string | undefined,
  fallbackMessage: string,
): string {
  return failure instanceof ApiError && failure.status === 503 && unavailableMessage
    ? unavailableMessage
    : failure instanceof Error
      ? failure.message
      : fallbackMessage;
}

/**
 * The one "load a list from `/path`, track loading/error, expose a reload" shape every
 * operations screen needs. Centralising it is what keeps a screen's own file about what the
 * screen does, not about re-deriving a 503-aware fetch each time.
 */
export function useApiList<T>(
  path: string,
  options: { unavailableMessage?: string; fallbackMessage: string },
) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRows(items<T>((await apiRequest<unknown>(path)).data));
      setError(undefined);
    } catch (failure) {
      setError(apiFailureMessage(failure, options.unavailableMessage, options.fallbackMessage));
    } finally {
      setLoading(false);
    }
    // `options` is a fresh object every render; only `path` should trigger a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { rows, setRows, loading, error, setError, reload };
}
