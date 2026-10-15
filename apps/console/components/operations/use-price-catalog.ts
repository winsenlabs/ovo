'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, items } from '../../lib/api';
import type { PriceCatalogItem } from '../../lib/types/price-catalog';

/** Shared catalog fetch for the Overview coverage donut and the Price catalog table — both read
 * the same `/cost/price-catalog` collection, so the loading state lives in one place. */
export function usePriceCatalog(): {
  catalog: PriceCatalogItem[] | null;
  error: string | undefined;
  reload: () => Promise<void>;
} {
  const [catalog, setCatalog] = useState<PriceCatalogItem[] | null>(null);
  const [error, setError] = useState<string>();
  const reload = useCallback(async () => {
    try {
      setCatalog(items<PriceCatalogItem>((await apiRequest<unknown>('/cost/price-catalog')).data));
      setError(undefined);
    } catch (failure) {
      setCatalog([]);
      setError(failure instanceof Error ? failure.message : 'Price catalog could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { catalog, error, reload };
}
