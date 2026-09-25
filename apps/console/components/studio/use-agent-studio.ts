'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleExtension } from '@winsendotai/ovo-ui';
import {
  apiRequest,
  ApiError,
  emptyAgentConfig,
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
export function useAgentStudio(extensions: readonly ConsoleExtension[], preferredAgentId?: string) {
  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const [selected, setSelected] = useState<AgentDraft>();
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
  const [publishing, setPublishing] = useState(false);
  const generation = useRef(0);
  const saving = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    setSelected(undefined);
    try {
      const [{ data: agentPayload }, bindingResult, preferredResult] = await Promise.all([
        apiRequest<unknown>('/agents'),
        apiRequest<unknown>('/provider-bindings').catch(() => ({ data: { items: [] } })),
        preferredAgentId
          ? apiRequest<unknown>(`/agents/${encodeURIComponent(preferredAgentId)}`)
          : Promise.resolve(undefined),
      ]);
      const summaries = items<Record<string, unknown>>(agentPayload);
      const drafts = summaries.filter((item) => item.config).map((item) => normalizeDraft(item));
      const preferred = preferredResult
        ? normalizeDraft(preferredResult.data, preferredResult.etag)
        : undefined;
      if (summaries.length && !drafts.length) {
        const details = await Promise.all(
          summaries.map(async (item) => {
            const result = await apiRequest<unknown>(`/agents/${String(item.id ?? item.agentId)}`);
            return normalizeDraft(result.data, result.etag);
          }),
        );
        setAgents(
          preferred && !details.some((item) => item.id === preferred.id)
            ? [preferred, ...details]
            : details,
        );
        setSelected(preferred ?? details[0]);
      } else {
        setAgents(
          preferred && !drafts.some((item) => item.id === preferred.id)
            ? [preferred, ...drafts]
            : drafts,
        );
        setSelected(preferred ?? drafts[0]);
      }
      setBindings(items<ProviderBinding>(bindingResult.data));
    } catch (error) {
      setLoadError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [preferredAgentId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!selected) {
      setReleases([]);
      setReadiness(undefined);
      return;
    }
    setReadinessError(undefined);
    void Promise.all([
      apiRequest<unknown>(`/agents/${selected.id}/releases`)
        .then(({ data }) => setReleases(items<Release>(data)))
        .catch((error) => setReleaseError(describeError(error))),
      apiRequest<AgentReadiness>(`/agents/${selected.id}/readiness`)
        .then(({ data }) => setReadiness(data))
        .catch((error) => setReadinessError(describeError(error))),
    ]);
  }, [selected?.id, selected?.draftVersion]);

  const save = useCallback(async (draft: AgentDraft, editGeneration: number) => {
    if (saving.current) return;
    saving.current = true;
    setSaveState('saving');
    setSaveError(undefined);
    setConflict(undefined);
    try {
      const result = await apiRequest<unknown>(`/agents/${draft.id}`, {
        method: 'PUT',
        headers: { 'if-match': ifMatch(draft.draftVersion) },
        body: JSON.stringify({ config: draft.config }),
      });
      const saved = normalizeDraft(result.data, result.etag);
      setSelected((current) =>
        current && current.id === draft.id
          ? {
              ...current,
              draftVersion: saved.draftVersion,
              ...(generation.current === editGeneration
                ? { config: saved.config ?? current.config }
                : {}),
            }
          : current,
      );
      setAgents((current) =>
        current.map((item) =>
          item.id === draft.id
            ? {
                ...item,
                draftVersion: saved.draftVersion,
                ...(generation.current === editGeneration
                  ? { config: saved.config ?? item.config }
                  : {}),
              }
            : item,
        ),
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
  }, []);

  useEffect(() => {
    if (!selected || saveState !== 'dirty') return;
    const snapshot = selected;
    const editGeneration = generation.current;
    const timer = window.setTimeout(() => void save(snapshot, editGeneration), 700);
    return () => window.clearTimeout(timer);
  }, [selected, save, saveState]);

  function update(next: AgentConfig) {
    generation.current += 1;
    setSelected((current) => (current ? { ...current, config: next } : current));
    setAgents((current) =>
      current.map((item) => (item.id === selected?.id ? { ...item, config: next } : item)),
    );
    setSaveState('dirty');
  }

  async function createAgent() {
    setLoadError(undefined);
    try {
      const result = await apiRequest<unknown>('/agents', {
        method: 'POST',
        body: JSON.stringify({ config: emptyAgentConfig() }),
      });
      const created = normalizeDraft(result.data, result.etag);
      setAgents((current) => [...current, created]);
      setSelected(created);
      setSaveState('saved');
    } catch (error) {
      setLoadError(describeError(error));
    }
  }

  async function publish() {
    if (!selected) return;
    setPublishing(true);
    setReleaseError(undefined);
    try {
      const { data } = await apiRequest<Release>(`/agents/${selected.id}/releases`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setReleases((current) => [data, ...current]);
    } catch (error) {
      setReleaseError(describeError(error));
    } finally {
      setPublishing(false);
    }
  }

  const activeForms = useMemo(
    () =>
      selected
        ? extensions
            .flatMap((extension) => extension.forms)
            .filter((form) => form.modes.includes(selected.config.mode))
        : [],
    [extensions, selected],
  );
  return {
    agents,
    setSelected,
    selected,
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
    publishing,
    update,
    createAgent,
    publish,
    activeForms,
  };
}
