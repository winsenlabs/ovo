'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, items, ApiError, type SessionIdentity } from '../../lib/api';
import type { EvaluationDataset } from '../../lib/operator-api';
import type { ProviderEvaluationAuthorization } from '../../lib/operator-api';
import { LoadingBlock } from '../primitives';
import { EvaluationDatasetPanel } from './evaluation-dataset-panel';
import { EvaluationRunsPanel } from './evaluation-runs-panel';
import { EvaluationProviderAuthorizations } from './evaluation-provider-authorizations';
import type { ProviderEvaluationAvailability } from './evaluation-provider-state';
import { TestAndEvaluationView } from './evaluations-view';

export function EvaluationDatasetsView({ role }: { role: SessionIdentity['role'] }) {
  const [datasets, setDatasets] = useState<EvaluationDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [providerAuthorizations, setProviderAuthorizations] = useState<
    ProviderEvaluationAuthorization[]
  >([]);
  const [providerAvailability, setProviderAvailability] =
    useState<ProviderEvaluationAvailability>('unknown');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDatasets(
        items<EvaluationDataset>(
          (await apiRequest<unknown>('/evaluation-datasets?limit=100')).data,
        ),
      );
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'The durable evaluation service is not configured.'
          : failure instanceof Error
            ? failure.message
            : 'Evaluation datasets could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (loading) return <LoadingBlock label="Loading durable evaluation datasets" />;
  return (
    <div className="stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Regression operations</p>
          <h1>Evaluation datasets & jobs</h1>
          <p className="muted">
            Immutable corpora, fixture-isolated defaults, provider authorization, durable jobs, and
            case-level comparison evidence.
          </p>
        </div>
      </header>
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
      <TestAndEvaluationView simulationsOnly embedded />
      <EvaluationDatasetPanel role={role} datasets={datasets} reload={load} />
      <EvaluationProviderAuthorizations
        role={role}
        onChange={(authorizations, availability) => {
          setProviderAuthorizations(authorizations);
          setProviderAvailability(availability);
        }}
      />
      <EvaluationRunsPanel
        role={role}
        datasets={datasets}
        providerAuthorizations={providerAuthorizations}
        providerAvailability={providerAvailability}
      />
    </div>
  );
}
