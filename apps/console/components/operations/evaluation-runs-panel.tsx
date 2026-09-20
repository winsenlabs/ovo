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
import { Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { EvaluationRunEvidence } from './evaluation-run-evidence';
import {
  activeProviderAuthorizations,
  providerRunAuthorization,
  type ProviderEvaluationAvailability,
} from './evaluation-provider-state';

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
          <Notice tone="danger" live>
            {error}
          </Notice>
        )}
        {role !== 'viewer' && (
          <form className="nested-card stack" onSubmit={createRun}>
            <h4>Queue immutable evaluation run</h4>
            <div className="form-grid">
              <Field label="Dataset" htmlFor="run-dataset">
                <select
                  id="run-dataset"
                  name="datasetId"
                  value={runDatasetId}
                  onChange={(event) => setRunDatasetId(event.target.value)}
                  required
                >
                  {datasets
                    .filter((dataset) => dataset.currentVersion > 0)
                    .map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Current immutable version" htmlFor="run-dataset-version">
                <input
                  id="run-dataset-version"
                  name="datasetVersion"
                  value={
                    datasets.find((dataset) => dataset.id === runDatasetId)?.currentVersion ?? ''
                  }
                  readOnly
                />
              </Field>
              <Field label="Agent" htmlFor="run-agent">
                <select
                  id="run-agent"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.config.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Immutable release" htmlFor="run-release">
                <select
                  id="run-release"
                  name="releaseId"
                  value={releaseId}
                  onChange={(event) => setReleaseId(event.target.value)}
                  required
                >
                  {releases.map((release) => (
                    <option key={release.id} value={release.id}>
                      {release.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Executor" htmlFor="run-executor">
                <select
                  id="run-executor"
                  value={executorKind}
                  onChange={(event) =>
                    setExecutorKind(event.target.value as 'fixture' | 'provider')
                  }
                >
                  <option value="fixture">Fixture-only · no network/provider</option>
                  <option
                    value="provider"
                    disabled={role !== 'admin' || providerAvailability !== 'enabled'}
                  >
                    Provider-backed · admin authorization and cost
                  </option>
                </select>
              </Field>
              <Field label="Maximum attempts" htmlFor="run-attempts">
                <input
                  id="run-attempts"
                  name="maxAttempts"
                  type="number"
                  min={1}
                  max={5}
                  value={executorKind === 'provider' ? 1 : maxAttempts}
                  readOnly={executorKind === 'provider'}
                  onChange={(event) => setMaxAttempts(Number(event.target.value))}
                />
              </Field>
              {executorKind === 'provider' && (
                <Field label="Active authorization" htmlFor="run-provider-authorization">
                  <select
                    id="run-provider-authorization"
                    value={providerAuthorizationId}
                    onChange={(event) => setProviderAuthorizationId(event.target.value)}
                    required
                  >
                    <option value="">Select release-matched authorization</option>
                    {matchingAuthorizations.map((authorization) => (
                      <option key={authorization.id} value={authorization.id}>
                        {authorization.provider} · {authorization.modelId} · binding{' '}
                        {authorization.bindingVersion} · budget {authorization.budgetId} · max{' '}
                        {authorization.maximumReservationPaise} paise
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            {executorKind === 'provider' && (
              <Notice tone="warning">
                Provider evaluation is explicit, version-pinned, budget-authorized, and may incur
                cost. The selected authorization must match this immutable release and its exact
                binding version. This screen cannot enable the server installation flag.
              </Notice>
            )}
            <button
              className="button primary align-start"
              disabled={
                busy ||
                !runDatasetId ||
                releases.length === 0 ||
                (executorKind === 'provider' && !providerAuthorizationId)
              }
            >
              Queue evaluation run
            </button>
          </form>
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
