'use client';
import { useState } from 'react';

/** Shared `<Tabs>` state for a page's tabbed shell (Costs, Evaluations): typed to the tab list's
 * own ids, defaulting to the first one. */
export function useTabState<T extends string>(initial: T): [T, (next: string) => void] {
  const [tab, setTab] = useState<T>(initial);
  return [tab, (next) => setTab(next as T)];
}
