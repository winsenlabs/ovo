'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest, items, type SessionIdentity } from '../../lib/api';
import type {
  EvaluationDataset,
  EvaluationRunRecord,
  ProviderEvaluationAuthorization,
} from '../../lib/operator-api';
import {
  failedRunPoints,
  latestPassRateByDataset,
  passRateTrend,
  runsSince,
} from '../../lib/derive/evaluations';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { DataTableV2 } from '../ui/data-table-v2';
import { Drawer } from '../ui/drawer';
import { Button } from '../ui/button';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { EvaluationPassRateChart } from './evaluation-pass-rate-chart';
import { buildRunColumns } from './evaluation-runs-columns';
import { EvaluationRunForm } from './evaluation-run-form';
import { EvaluationRunDetailDrawer, EvaluationRunCompare } from './evaluation-run-evidence';
import { useRunQueueForm } from './use-run-queue-form';
import type { ProviderEvaluationAvailability } from './evaluation-provider-state';

/**
 * Durable evaluation jobs: a KPI strip, a pass-rate trend line per dataset, a DataTableV2 with
 * correct status tones and an inline pass/fail bar, a run-detail drawer, a queue-run drawer, and
 * the baseline/candidate comparison — replacing a 14-row table where running/queued/cancelled all
 * rendered the same green as succeeded (brief defect #14).
 */
export function EvaluationRunsPanel({
  role,
  datasets,
  providerAuthorizations,
  providerAvailability,
}: {
  role: SessionIdentity['role'];
  datasets: readonly EvaluationDataset[];
  providerAuthorizations: readonly ProviderEvaluationAuthorization[];
  providerAvailability: ProviderEvaluationAvailability;
}) {
  const [runs, setRuns] = useState<EvaluationRunRecord[]>([]);
  // Split from the initial list fetch: a 503 on `loadRuns` means the service itself is down and
  // the whole panel should say so once, instead of a cancel/queue failure (`actionError`) — which
  // leaves already-loaded runs on screen — replacing it too. Mixing the two produced "No durable
  // evaluation runs" and a bare error line side by side with "Queue run" still offered during an
  // outage (verifier medium #10).
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [detailRun, setDetailRun] = useState<EvaluationRunRecord | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(
        items<EvaluationRunRecord>((await apiRequest<unknown>('/evaluation-runs?limit=100')).data),
      );
      setLoadError(undefined);
    } catch (failure) {
      setLoadError(
        failure instanceof Error ? failure.message : 'Evaluation runs could not be loaded.',
      );
    }
  }, []);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const queue = useRunQueueForm({
    datasets,
    role,
    providerAuthorizations,
    providerAvailability,
    onQueued: loadRuns,
    reportError: setActionError,
  });

  async function cancel(run: EvaluationRunRecord) {
    setBusy(true);
    try {
      await apiRequest(`/evaluation-runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' });
      await loadRuns();
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : 'Evaluation run could not be cancelled.',
      );
    } finally {
      setBusy(false);
    }
  }

  const recentRuns = runsSince(runs, 7);
  const latestPassRates = [...latestPassRateByDataset(runs).values()];
  const avgPassRate = latestPassRates.length
    ? Math.round(
        (latestPassRates.reduce((sum, rate) => sum + rate, 0) / latestPassRates.length) * 100,
      )
    : null;
  const trend = useMemo(() => passRateTrend(runs, datasets), [runs, datasets]);
  const failures = useMemo(() => failedRunPoints(runs, datasets), [runs, datasets]);
  const columns = buildRunColumns({
    datasets,
    role,
    busy,
    onSelect: setDetailRun,
    onCancel: (run) => void cancel(run),
  });
  const inProgress = runs.filter((run) =>
    ['queued', 'running', 'cancelling'].includes(run.status),
  ).length;

  if (loadError)
    return (
      <EmptyStateV2
        variant="unavailable"
        title="Evaluation runs unavailable"
        action={
          <Button type="button" onClick={() => void loadRuns()}>
            Retry
          </Button>
        }
      >
        {loadError}
      </EmptyStateV2>
    );

  return (
    <div className="ds-stack">
      <KpiStrip>
        <KpiCard
          label="Avg. latest pass rate"
          value={avgPassRate != null ? `${avgPassRate}%` : null}
        />
        <KpiCard label="Runs · 7d" value={recentRuns.length} />
        <KpiCard
          label="Failing runs"
          value={runs.filter((run) => run.status === 'failed').length}
        />
        <KpiCard label="In progress" value={inProgress} />
      </KpiStrip>
      <EvaluationPassRateChart trend={trend} failures={failures} />
      <SectionCard
        title="Durable evaluation jobs"
        padding="flush"
        actions={
          role !== 'viewer' ? (
            <Button variant="primary" type="button" onClick={() => queue.setOpen(true)}>
              Queue run
            </Button>
          ) : undefined
        }
      >
        {actionError && (
          <div className="field-error" role="alert">
            {actionError}
          </div>
        )}
        <DataTableV2
          // See price-catalog-panel.tsx: remounts across the empty → loaded boundary to avoid
          // DataTableV2's hook-count mismatch (foundation request in the build report).
          key={runs.length > 0 ? 'loaded' : 'empty'}
          label="Evaluation runs"
          rows={runs}
          columns={columns}
          rowKey={(run) => run.id}
          empty="No durable evaluation runs. Import a corpus version and queue a fixture-only evaluation."
        />
      </SectionCard>
      <EvaluationRunCompare runs={runs} />
      <EvaluationRunDetailDrawer
        run={detailRun}
        open={detailRun !== null}
        onClose={() => setDetailRun(null)}
      />
      {role !== 'viewer' && (
        <Drawer
          open={queue.open}
          title="Queue immutable evaluation run"
          onClose={() => queue.setOpen(false)}
        >
          <EvaluationRunForm
            datasets={datasets}
            runDatasetId={queue.runDatasetId}
            setRunDatasetId={queue.setRunDatasetId}
            agents={queue.agents}
            agentId={queue.agentId}
            setAgentId={queue.setAgentId}
            releases={queue.releases}
            releaseId={queue.releaseId}
            setReleaseId={queue.setReleaseId}
            executorKind={queue.executorKind}
            setExecutorKind={queue.setExecutorKind}
            role={role}
            providerAvailability={providerAvailability}
            maxAttempts={queue.maxAttempts}
            setMaxAttempts={queue.setMaxAttempts}
            providerAuthorizationId={queue.providerAuthorizationId}
            setProviderAuthorizationId={queue.setProviderAuthorizationId}
            matchingAuthorizations={queue.matchingAuthorizations}
            busy={queue.busy}
            createRun={queue.createRun}
          />
        </Drawer>
      )}
    </div>
  );
}
