'use client';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { AgentDraft, Release, SessionIdentity } from '../../lib/api';
import type { EvaluationDataset, ProviderEvaluationAuthorization } from '../../lib/operator-api';
import { Field, Notice } from '../primitives';
import type { ProviderEvaluationAvailability } from './evaluation-provider-state';
export function EvaluationRunForm({
  datasets,
  runDatasetId,
  setRunDatasetId,
  agents,
  agentId,
  setAgentId,
  releases,
  releaseId,
  setReleaseId,
  executorKind,
  setExecutorKind,
  role,
  providerAvailability,
  maxAttempts,
  setMaxAttempts,
  providerAuthorizationId,
  setProviderAuthorizationId,
  matchingAuthorizations,
  busy,
  createRun,
}: {
  datasets: EvaluationDataset[];
  runDatasetId: string;
  setRunDatasetId: Dispatch<SetStateAction<string>>;
  agents: AgentDraft[];
  agentId: string;
  setAgentId: Dispatch<SetStateAction<string>>;
  releases: Release[];
  releaseId: string;
  setReleaseId: Dispatch<SetStateAction<string>>;
  executorKind: 'fixture' | 'provider';
  setExecutorKind: Dispatch<SetStateAction<'fixture' | 'provider'>>;
  role: SessionIdentity['role'];
  providerAvailability: ProviderEvaluationAvailability;
  maxAttempts: number;
  setMaxAttempts: Dispatch<SetStateAction<number>>;
  providerAuthorizationId: string;
  setProviderAuthorizationId: Dispatch<SetStateAction<string>>;
  matchingAuthorizations: ProviderEvaluationAuthorization[];
  busy: boolean;
  createRun: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
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
            value={datasets.find((dataset) => dataset.id === runDatasetId)?.currentVersion ?? ''}
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
            onChange={(event) => setExecutorKind(event.target.value as 'fixture' | 'provider')}
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
          Provider evaluation is explicit, version-pinned, budget-authorized, and may incur cost.
          The selected authorization must match this immutable release and its exact binding
          version. This screen cannot enable the server installation flag.
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
  );
}
