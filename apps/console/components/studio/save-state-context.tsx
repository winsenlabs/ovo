'use client';
// Lets the Configure tab's draft save state reach `AgentShell` — a different route segment, and
// so a different React subtree — so the shared header can disable Publish while there are unsaved
// changes and refresh the readiness pill right after an autosave completes (brief §3 "Agent
// detail / studio": Publish must not be clickable over a stale server draft).
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type DraftSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

type SaveStateContextValue = {
  saveState: DraftSaveState;
  report: (state: DraftSaveState) => void;
};

const SaveStateContext = createContext<SaveStateContextValue | undefined>(undefined);

export function SaveStateProvider({ children }: { children: ReactNode }) {
  const [saveState, setSaveState] = useState<DraftSaveState>('idle');
  const value = useMemo(() => ({ saveState, report: setSaveState }), [saveState]);
  return <SaveStateContext.Provider value={value}>{children}</SaveStateContext.Provider>;
}

/** The active Configure tab's save state, as last reported by `useReportSaveState` — `'idle'`
 * when nothing has reported (no provider in the tree, or Configure has not mounted this visit). */
export function useDraftSaveState(): DraftSaveState {
  return useContext(SaveStateContext)?.saveState ?? 'idle';
}

/** `useAgentStudio`'s own `saveState` reported up to the shared shell. */
export function useReportSaveState(state: DraftSaveState) {
  const context = useContext(SaveStateContext);
  useEffect(() => {
    context?.report(state);
    // On unmount (navigating off Configure) the shell should stop treating a stale save state as
    // still live — back to idle, which never blocks Publish or itself asks for a refresh.
    return () => context?.report('idle');
  }, [context, state]);
}
