'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, items, ApiError, type SessionIdentity } from '../../lib/api';
import type { EvaluationDataset, ProviderEvaluationAuthorization } from '../../lib/operator-api';
import { PageHeader } from '../ui/layout';
import { Tabs } from '../ui/tabs';
import { useTabState } from './use-tab-state';
import { InlineAlert, Skeleton } from '../ui/feedback-v2';
import { EvaluationDatasetPanel } from './evaluation-dataset-panel';
import { EvaluationRunsPanel } from './evaluation-runs-panel';
import { EvaluationProviderAuthorizations } from './evaluation-provider-authorizations';
import type { ProviderEvaluationAvailability } from './evaluation-provider-state';
import { TestAndEvaluationView } from './evaluations-view';

type TabId = 'runs' | 'datasets' | 'simulations' | 'provider';
const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'runs', label: 'Runs' },
  { id: 'datasets', label: 'Datasets' },
  { id: 'simulations', label: 'Simulations' },
  { id: 'provider', label: 'Provider access' },
];

/**
 * Evaluations: header → tabs (Runs · Datasets · Simulations · Provider access), with the quality
 * trend and durable runs first, instead of a simulation form at the top of a 5,900px page (brief
 * defect "there is no quality trend, the forms come first").
 */
export function EvaluationDatasetsView({ role }: { role: SessionIdentity['role'] }) {
  const [tab, setTab] = useTabState<TabId>('runs');
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

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Insights"
        title="Evaluations"
        description="Immutable corpora, fixture-isolated defaults, provider authorization, durable jobs, and case-level comparison evidence."
      />
      {/* A bare `field-error` line had no way to retry a failed load (verifier medium #10). */}
      {error && <InlineAlert onRetry={() => void load()}>{error}</InlineAlert>}
      <Tabs items={TABS} current={tab} onSelect={setTab} panelId="evaluations-tab-panel" />
      <div id="evaluations-tab-panel" role="tabpanel" className="ds-stack">
        {loading ? (
          <Skeleton shape="chart" />
        ) : tab === 'runs' ? (
          <EvaluationRunsPanel
            role={role}
            datasets={datasets}
            providerAuthorizations={providerAuthorizations}
            providerAvailability={providerAvailability}
          />
        ) : tab === 'datasets' ? (
          <EvaluationDatasetPanel role={role} datasets={datasets} reload={load} />
        ) : tab === 'simulations' ? (
          <TestAndEvaluationView simulationsOnly embedded />
        ) : null}
        {/* Mounted regardless of which tab is active (not just when "Provider access" is open):
            the Runs tab needs its authorizations to offer the provider-backed executor option. */}
        <div hidden={tab !== 'provider'}>
          <EvaluationProviderAuthorizations
            role={role}
            onChange={(authorizations, availability) => {
              setProviderAuthorizations(authorizations);
              setProviderAvailability(availability);
            }}
          />
        </div>
      </div>
    </div>
  );
}
