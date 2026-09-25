'use client';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  apiRequest,
  items,
  type AgentDraft,
  type Release,
  type SessionIdentity,
} from '../../lib/api';
import type {
  EvaluationDataset,
  EvaluationRunRecord,
  ProviderEvaluationAuthorization,
} from '../../lib/operator-api';
import { Panel, PanelHeader, StatusBadge } from '../primitives';
import { EvaluationRunEvidence } from './evaluation-run-evidence';
import {
  activeProviderAuthorizations,
  providerRunAuthorization,
  type ProviderEvaluationAvailability,
} from './evaluation-provider-state';
import { EvaluationRunForm } from './evaluation-run-form';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `run-${Date.now()}`;

export function EvaluationRunsPanel({
  role,
  datasets,
  providerAuthorizations,
  providerAvailability,
}: {
  role: SessionIdentity['role'];
  datasets: EvaluationDataset[];
  providerAuthorizations: ProviderEvaluationAuthorization[];
  providerAvailability: ProviderEvaluationAvailability;
}) {
  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const [runDatasetId, setRunDatasetId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseId, setReleaseId] = useState('');
  const [runs, setRuns] = useState<EvaluationRunRecord[]>([]);
  const [focusRunId, setFocusRunId] = useState('');
  const [executorKind, setExecutorKind] = useState<'fixture' | 'provider'>('fixture');
  const [providerAuthorizationId, setProviderAuthorizationId] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadRuns = useCallback(async () => {
    try {
      const next = items<EvaluationRunRecord>(
        (await apiRequest<unknown>('/evaluation-runs?limit=100')).data,
      );
      setRuns(next);
      setError(undefined);
    } catch (failure) {
      setError(message(failure, 'Evaluation runs could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      apiRequest<unknown>('/agents').then(({ data }) => {
        const next = items<AgentDraft>(data);
        setAgents(next);
        setAgentId(next[0]?.id ?? '');
      }),
      loadRuns(),
    ]).catch((failure) => setError(message(failure, 'Evaluation dependencies unavailable.')));
  }, [loadRuns]);

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
      .catch((failure) => setError(message(failure, 'Immutable releases could not be loaded.')));
  }, [agentId]);

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
    setError(undefined);
    try {
      const providerAuthorization =
        executorKind === 'provider'
          ? providerRunAuthorization(
              providerAuthorizations,
              String(values.get('releaseId')),
              providerAuthorizationId,
            )
          : undefined;
      const { data } = await apiRequest<EvaluationRunRecord>('/evaluation-runs', {
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
      await loadRuns();
      setFocusRunId(data.id);
    } catch (failure) {
      setError(message(failure, 'Evaluation run could not be queued.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel labelledBy="evaluation-runs-title">
      <PanelHeader
        id="evaluation-runs-title"
        title="Durable evaluation jobs"
        badge={<StatusBadge tone="soft">{runs.length} recent</StatusBadge>}
      />
      <div className="panel-body stack">
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        {role !== 'viewer' && (
          <EvaluationRunForm
            datasets={datasets}
            runDatasetId={runDatasetId}
            setRunDatasetId={setRunDatasetId}
            agents={agents}
            agentId={agentId}
            setAgentId={setAgentId}
            releases={releases}
            releaseId={releaseId}
            setReleaseId={setReleaseId}
            executorKind={executorKind}
            setExecutorKind={setExecutorKind}
            role={role}
            providerAvailability={providerAvailability}
            maxAttempts={maxAttempts}
            setMaxAttempts={setMaxAttempts}
            providerAuthorizationId={providerAuthorizationId}
            setProviderAuthorizationId={setProviderAuthorizationId}
            matchingAuthorizations={matchingAuthorizations}
            busy={busy}
            createRun={createRun}
          />
        )}
        <EvaluationRunEvidence
          role={role}
          runs={runs}
          focusRunId={focusRunId}
          reload={loadRuns}
          reportError={setError}
        />
      </div>
    </Panel>
  );
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
