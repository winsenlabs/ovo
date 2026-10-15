'use client';
// Single-agent draft editing (brief §3 "Agent detail / studio": remove the agent switcher, it
// duplicates the Agents list). Loading, saving, conflicts and release readiness are all scoped to
// the one `agentId` the Configure route is mounted with — exactly like the plugins/test/releases
// tabs already load by `agentId`, instead of the old page's own `/agents` list + switcher.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import {
  apiRequest,
  ApiError,
  ifMatch,
  items,
  normalizeDraft,
  type AgentConfig,
  type AgentDraft,
  type AgentReadiness,
  type ProviderBinding,
  type Release,
} from '../../lib/api';
import { describeError } from '../../lib/errors';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export function useAgentStudio(agentId: string, extensions: readonly ConsoleExtension[]) {
  const [draft, setDraft] = useState<AgentDraft>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string>();
  const [conflict, setConflict] = useState<unknown>();
  const [bindings, setBindings] = useState<ProviderBinding[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseError, setReleaseError] = useState<string>();
  const [readiness, setReadiness] = useState<AgentReadiness>();
  const [readinessError, setReadinessError] = useState<string>();
  const generation = useRef(0);
  const saving = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const [agentResult, bindingResult] = await Promise.all([
        apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}`),
        apiRequest<unknown>('/provider-bindings').catch(() => ({ data: { items: [] } })),
      ]);
      setDraft(normalizeDraft(agentResult.data, agentResult.etag));
      setBindings(items<ProviderBinding>(bindingResult.data));
      setSaveState('idle');
    } catch (error) {
      setLoadError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!draft) return;
    setReadinessError(undefined);
    void Promise.all([
      apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}/releases`)
        .then(({ data }) => setReleases(items<Release>(data)))
        .catch((error) => setReleaseError(describeError(error))),
      apiRequest<AgentReadiness>(`/agents/${encodeURIComponent(agentId)}/readiness`)
        .then(({ data }) => setReadiness(data))
        .catch((error) => setReadinessError(describeError(error))),
    ]);
  }, [agentId, draft?.draftVersion]);

  const save = useCallback(
    async (next: AgentDraft, editGeneration: number) => {
      if (saving.current) return;
      saving.current = true;
      setSaveState('saving');
      setSaveError(undefined);
      setConflict(undefined);
      try {
        const result = await apiRequest<unknown>(`/agents/${agentId}`, {
          method: 'PUT',
          headers: { 'if-match': ifMatch(next.draftVersion) },
          body: JSON.stringify({ config: next.config }),
        });
        const saved = normalizeDraft(result.data, result.etag);
        setDraft((current) =>
          current
            ? {
                ...current,
                draftVersion: saved.draftVersion,
                ...(generation.current === editGeneration
                  ? { config: saved.config ?? current.config }
                  : {}),
              }
            : current,
        );
        setSaveState(generation.current === editGeneration ? 'saved' : 'dirty');
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          setSaveState('conflict');
          setConflict(error.details?.current);
        } else {
          setSaveState('error');
          setSaveError(describeError(error));
        }
      } finally {
        saving.current = false;
      }
    },
    [agentId],
  );

  useEffect(() => {
    if (!draft || saveState !== 'dirty') return;
    const snapshot = draft;
    const editGeneration = generation.current;
    const timer = window.setTimeout(() => void save(snapshot, editGeneration), 700);
    return () => window.clearTimeout(timer);
  }, [draft, save, saveState]);

  function update(next: AgentConfig) {
    generation.current += 1;
    setDraft((current) => (current ? { ...current, config: next } : current));
    setSaveState('dirty');
  }

  const activeForms = draft
    ? extensions
        .flatMap((extension) => extension.forms)
        .filter((form) => form.modes.includes(draft.config.mode))
    : [];

  return {
    draft,
    loading,
    loadError,
    load,
    saveState,
    saveError,
    conflict,
    bindings,
    releases,
    readiness,
    readinessError,
    releaseError,
    update,
    activeForms,
  };
}
