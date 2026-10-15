'use client';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { AgentDraft, Release, SessionIdentity } from '../../lib/api';
import type { EvaluationDataset, ProviderEvaluationAuthorization } from '../../lib/operator-api';
import { InlineAlert } from '../ui/feedback-v2';
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
  datasets: readonly EvaluationDataset[];
  runDatasetId: string;
  setRunDatasetId: Dispatch<SetStateAction<string>>;
  agents: readonly AgentDraft[];
  agentId: string;
  setAgentId: Dispatch<SetStateAction<string>>;
  releases: readonly Release[];
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
  matchingAuthorizations: readonly ProviderEvaluationAuthorization[];
  busy: boolean;
  createRun: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  return (
    <form className="stack" onSubmit={createRun}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="run-dataset">Dataset</label>
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
        </div>
        <div className="field">
          <label htmlFor="run-dataset-version">Current immutable version</label>
          <input
            id="run-dataset-version"
            name="datasetVersion"
            value={datasets.find((dataset) => dataset.id === runDatasetId)?.currentVersion ?? ''}
            readOnly
          />
        </div>
        <div className="field">
          <label htmlFor="run-agent">Agent</label>
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
        </div>
        <div className="field">
          <label htmlFor="run-release">Immutable release</label>
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
        </div>
        <div className="field">
          <label htmlFor="run-executor">Executor</label>
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
        </div>
        <div className="field">
          <label htmlFor="run-attempts">Maximum attempts</label>
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
        </div>
        {executorKind === 'provider' && (
          <div className="field">
            <label htmlFor="run-provider-authorization">Active authorization</label>
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
                  {authorization.bindingVersion} · budget {authorization.budgetId}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {executorKind === 'provider' && (
        <InlineAlert tone="warn">
          Provider evaluation is explicit, version-pinned, budget-authorized, and may incur cost.
          The selected authorization must match this immutable release and its exact binding
          version.
        </InlineAlert>
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
