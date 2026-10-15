'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, items, ApiError } from '../../lib/api';

/**
 * Shared "fetch one `{items:[...]}` collection, keep it in state, offer a reload" pattern used by
 * budgets, FX versions and price cards. `path === null` skips the fetch (e.g. a non-admin viewer
 * of an admin-only collection) and leaves `data` as `null` rather than an empty, misleading list.
 */
export function useListResource<T>(
  path: string | null,
  unavailableMessage?: string,
): { data: T[] | null; error: string | undefined; reload: () => Promise<void> } {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    if (path === null) return;
    try {
      setData(items<T>((await apiRequest<unknown>(path)).data));
      setError(undefined);
    } catch (failure) {
      setData([]);
      setError(
        failure instanceof ApiError && failure.status === 503 && unavailableMessage
          ? unavailableMessage
          : failure instanceof Error
            ? failure.message
            : 'Could not be loaded.',
      );
    }
  }, [path, unavailableMessage]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}
