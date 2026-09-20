'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  apiRequest,
  items,
  type AgentDraft,
  type Release,
  type SessionIdentity,
} from '../../lib/api';
import type { EvaluationDataset, EvaluationRunRecord } from '../../lib/operator-api';
import { Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { EvaluationRunEvidence } from './evaluation-run-evidence';

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `run-${Date.now()}`;

export function EvaluationRunsPanel({
  role,
  datasets,
}: {
  role: SessionIdentity['role'];
  datasets: EvaluationDataset[];
}) {
  const [agents, setAgents] = useState<AgentDraft[]>([]);
  const [runDatasetId, setRunDatasetId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [releases, setReleases] = useState<Release[]>([]);
  const [runs, setRuns] = useState<EvaluationRunRecord[]>([]);
  const [focusRunId, setFocusRunId] = useState('');
  const [executorKind, setExecutorKind] = useState<'fixture' | 'provider'>('fixture');
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
      .then(({ data }) => setReleases(items<Release>(data)))
      .catch((failure) => setError(message(failure, 'Immutable releases could not be loaded.')));
  }, [agentId]);

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const { data } = await apiRequest<EvaluationRunRecord>('/evaluation-runs', {
        method: 'POST',
        body: JSON.stringify({
          datasetId: values.get('datasetId'),
          datasetVersion: Number(values.get('datasetVersion')),
          releaseId: values.get('releaseId'),
          idempotencyKey: newKey(),
          maxAttempts: Number(values.get('maxAttempts')),
          executorKind,
          ...(executorKind === 'provider'
            ? {
                providerBindingVersion: values.get('providerBindingVersion'),
                budgetAuthorizationId: values.get('budgetAuthorizationId'),
              }
            : {}),
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
                <select id="run-release" name="releaseId" required>
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
                  <option value="provider">Provider-backed · authorized cost</option>
                </select>
              </Field>
              <Field label="Maximum attempts" htmlFor="run-attempts">
                <input
                  id="run-attempts"
                  name="maxAttempts"
                  type="number"
                  min={1}
                  max={5}
                  defaultValue={3}
                />
              </Field>
              {executorKind === 'provider' && (
                <>
                  <Field label="Provider binding version" htmlFor="run-provider-version">
                    <input id="run-provider-version" name="providerBindingVersion" required />
                  </Field>
                  <Field label="Budget authorization ID" htmlFor="run-budget-authorization">
                    <input id="run-budget-authorization" name="budgetAuthorizationId" required />
                  </Field>
                </>
              )}
            </div>
            {executorKind === 'provider' && (
              <Notice tone="warning">
                Provider evaluation is explicit, version-pinned, budget-authorized, and may incur
                cost.
              </Notice>
            )}
            <button
              className="button primary align-start"
              disabled={busy || !runDatasetId || releases.length === 0}
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
