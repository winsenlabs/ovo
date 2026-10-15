'use client';
import { useCallback, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

/** A tabs selection synced with a `?tab=` query param, so a reload or a shared link lands on the
 * tab the viewer was actually looking at instead of always resetting to the first one (inspector
 * minor #12). `resetTab` is a raw local setter for a caller that needs to fall back to
 * `defaultTab` once it knows the current value is no longer valid, without pushing a URL change. */
export function useTabParam(defaultTab: string) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [tab, resetTab] = useState<string>(search.get('tab') || defaultTab);
  const setTab = useCallback(
    (next: string) => {
      resetTab(next);
      const nextSearch = new URLSearchParams(search.toString());
      nextSearch.set('tab', next);
      router.replace(`${pathname}?${nextSearch}`, { scroll: false });
    },
    [pathname, router, search],
  );
  return { tab, setTab, resetTab } as const;
}
