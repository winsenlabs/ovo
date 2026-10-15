'use client';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiRequest, items, type AgentDraft, type Release } from '../../lib/api';
import type {
  EvaluationDataset,
  EvaluationRunRecord,
  ProviderEvaluationAuthorization,
} from '../../lib/operator-api';
import { loadAgents } from '../../lib/pagination';
import {
  activeProviderAuthorizations,
  providerRunAuthorization,
  type ProviderEvaluationAvailability,
} from './evaluation-provider-state';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `run-${Date.now()}`;

/**
 * All the "queue a run" drawer's state and submit logic (agent → release lookup, the matching
 * provider authorization, the POST itself), extracted so `EvaluationRunsPanel` stays under the
 * module-size gate.
 */
export function useRunQueueForm({
  datasets,
  role,
  providerAuthorizations,
  providerAvailability,
  onQueued,
  reportError,
}: {
  datasets: readonly EvaluationDataset[];
  role: 'viewer' | 'editor' | 'admin';
  providerAuthorizations: readonly ProviderEvaluationAuthorization[];
  providerAvailability: ProviderEvaluationAvailability;
  onQueued: () => Promise<void>;
  reportError: (message: string) => void;
}) {
  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const [runDatasetId, setRunDatasetId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseId, setReleaseId] = useState('');
  const [executorKind, setExecutorKind] = useState<'fixture' | 'provider'>('fixture');
  const [providerAuthorizationId, setProviderAuthorizationId] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void loadAgents<AgentDraft>()
      .then((next) => {
        setAgents(next);
        setAgentId(next[0]?.id ?? '');
      })
      .catch((failure) =>
        reportError(failure instanceof Error ? failure.message : 'Agents unavailable.'),
      );
  }, [reportError]);

  useEffect(() => {
    setRunDatasetId((current) =>
      current && datasets.some((dataset) => dataset.id === current && dataset.currentVersion > 0)
        ? current
        : datasets.find((dataset) => dataset.currentVersion > 0)?.id || '',
    );
  }, [datasets]);

  useEffect(() => {
    if (!agentId) return setReleases([]);
    apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}/releases`)
      .then(({ data }) => {
        const next = items<Release>(data);
        setReleases(next);
        setReleaseId(next[0]?.id ?? '');
      })
      .catch((failure) =>
        reportError(
          failure instanceof Error ? failure.message : 'Immutable releases could not be loaded.',
        ),
      );
  }, [agentId, reportError]);

  const matchingAuthorizations = useMemo(
    () => activeProviderAuthorizations(providerAuthorizations, releaseId),
    [providerAuthorizations, releaseId],
  );
  useEffect(() => {
    setProviderAuthorizationId((current) =>
      matchingAuthorizations.some((authorization) => authorization.id === current)
        ? current
        : (matchingAuthorizations[0]?.id ?? ''),
    );
  }, [matchingAuthorizations]);
  useEffect(() => {
    if (role !== 'admin' || providerAvailability !== 'enabled') setExecutorKind('fixture');
  }, [providerAvailability, role]);

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const providerAuthorization =
        executorKind === 'provider'
          ? providerRunAuthorization(
              providerAuthorizations,
              String(values.get('releaseId')),
              providerAuthorizationId,
            )
          : undefined;
      await apiRequest<EvaluationRunRecord>('/evaluation-runs', {
        method: 'POST',
        body: JSON.stringify({
          datasetId: values.get('datasetId'),
          datasetVersion: Number(values.get('datasetVersion')),
          releaseId: values.get('releaseId'),
          idempotencyKey: newKey(),
          maxAttempts: executorKind === 'provider' ? 1 : Number(values.get('maxAttempts')),
          executorKind,
          ...providerAuthorization,
        }),
      });
      setOpen(false);
      await onQueued();
    } catch (failure) {
      reportError(
        failure instanceof Error ? failure.message : 'Evaluation run could not be queued.',
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    open,
    setOpen,
    busy,
    agents,
    runDatasetId,
    setRunDatasetId,
    agentId,
    setAgentId,
    releases,
    releaseId,
    setReleaseId,
    executorKind,
    setExecutorKind,
    maxAttempts,
    setMaxAttempts,
    providerAuthorizationId,
    setProviderAuthorizationId,
    matchingAuthorizations,
    createRun,
  };
}
