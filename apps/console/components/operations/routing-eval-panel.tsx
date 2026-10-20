'use client';
import { useMemo, useState } from 'react';
import type { SessionIdentity } from '../../lib/api';
import {
  routingEvalApi,
  useRoutingEvalRuns,
  type RoutingEvalRun,
  type RoutingEvalRunSummary,
} from '../../lib/data/routing-eval-api';
import { ChartFrame } from '../charts/chart-frame';
import { LineChart } from '../charts/line-chart';
import { CHART_PALETTE } from '../charts/scale';
import { Button } from '../ui/button';
import { DataTableV2 } from '../ui/data-table-v2';
import { Drawer } from '../ui/drawer';
import { ConfirmDialog } from '../ui/dialog';
import { EmptyStateV2, ErrorState, InlineAlert, Skeleton } from '../ui/feedback-v2';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { dataTableRenderKey } from '../../lib/data-table-remount-key';
import { pct, runColumns } from './routing-eval-columns';
import { RoutingEvalForm } from './routing-eval-form';
import { RoutingEvalRunDrawer } from './routing-eval-run-drawer';
import { latestRun, trendSeries } from './routing-eval-model';

/**
 * The Evaluations "Routing" tab: stored routing eval runs, the trend across them, the latest
 * run's headline numbers, and a drawer to run a corpus. Always states what an offline run is.
 */
export function RoutingEvalPanel({ role }: { role: SessionIdentity['role'] }) {
  const state = useRoutingEvalRuns();
  const [formOpen, setFormOpen] = useState(false);
  const [shown, setShown] = useState<RoutingEvalRunSummary | null>(null);
  const [deleting, setDeleting] = useState<RoutingEvalRunSummary | null>(null);
  const [actionError, setActionError] = useState<string>();
  const runs = state.status === 'ready' ? state.runs : [];
  const latest = latestRun(runs);
  const trend = useMemo(() => trendSeries(runs), [runs]);
  const tableRows = trend.flatMap((series) => series.points.map((point) => ({ series, point })));

  async function confirmDelete(yes: boolean) {
    const target = deleting;
    setDeleting(null);
    if (!yes || !target) return;
    try {
      await routingEvalApi.remove(target.id);
      setActionError(undefined);
      state.refresh();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : 'The run could not be deleted.');
    }
  }
  const started = (run: RoutingEvalRun) => {
    setFormOpen(false);
    setShown(run);
    state.refresh();
  };

  return (
    <div className="ds-stack">
      <InlineAlert tone="info">
        Offline runs use scripted engine answers: they score the tree, rules and pools, not model
        quality.
      </InlineAlert>
      {state.status === 'unavailable' && (
        <EmptyStateV2 variant="unavailable" title="Routing is not enabled here">
          Routing evaluation needs routing switched on for this installation.
        </EmptyStateV2>
      )}
      {state.status === 'error' && (
        <ErrorState
          title="Routing runs unavailable"
          message={state.message}
          onRetry={state.refresh}
        />
      )}
      {state.status === 'loading' && (
        <>
          <KpiStrip>
            {Array.from({ length: 4 }, (_, index) => (
              <KpiCard key={index} label="" value={null} loading />
            ))}
          </KpiStrip>
          <Skeleton shape="chart" width="100%" />
        </>
      )}
      {state.status === 'ready' && (
        <>
          <KpiStrip>
            <KpiCard
              label="Passed (latest run)"
              value={latest ? `${latest.headline.passed} of ${latest.headline.total}` : null}
              footnote={latest?.name}
            />
            <KpiCard label="Accuracy" value={pct(latest?.headline.accuracy ?? null)} />
            <KpiCard label="Fallback rate" value={pct(latest?.headline.fallbackRate ?? null)} />
            <KpiCard label="Clarify rate" value={pct(latest?.headline.clarifyRate ?? null)} />
          </KpiStrip>
          <SectionCard title="Accuracy and fallback rate across runs">
            <ChartFrame
              ariaLabel="Routing accuracy and fallback rate per run"
              empty={trend.length === 0}
              emptyLabel="No routing runs yet"
              legend={
                <ul className="ds-chart-legend">
                  {trend.map((series, index) => (
                    <li key={series.key}>
                      <span
                        className="ds-legend-swatch"
                        style={{ background: CHART_PALETTE[index % CHART_PALETTE.length] }}
                      />
                      {series.label}
                    </li>
                  ))}
                </ul>
              }
              tableRows={tableRows.length}
              tableColumns={[
                { header: 'Series', cell: (i) => tableRows[i]?.series.label },
                {
                  header: 'Run time',
                  cell: (i) => new Date(tableRows[i]?.point.x ?? 0).toLocaleString('en-IN'),
                },
                {
                  header: 'Rate',
                  cell: (i) => `${Math.round((tableRows[i]?.point.y ?? 0) * 100)}%`,
                },
              ]}
              renderChart={(width) => (
                <LineChart
                  series={trend}
                  width={width}
                  xScale="time"
                  yMax={1}
                  xFormat={(value) =>
                    new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                  }
                  yFormat={(value) => `${Math.round(value * 100)}%`}
                />
              )}
            />
          </SectionCard>
          <SectionCard
            title="Routing runs"
            padding="flush"
            actions={
              role !== 'viewer' ? (
                <Button variant="primary" type="button" onClick={() => setFormOpen(true)}>
                  Run a corpus
                </Button>
              ) : undefined
            }
          >
            {actionError && <InlineAlert>{actionError}</InlineAlert>}
            <DataTableV2
              key={dataTableRenderKey(false, undefined, runs.length)}
              label="Routing runs"
              rows={runs}
              rowKey={(run) => run.id}
              columns={runColumns(role, setShown, setDeleting)}
              empty={
                <EmptyStateV2 variant="first-run" title="No routing runs yet">
                  Run a corpus of caller utterances against a routing release to score its routing.
                </EmptyStateV2>
              }
            />
          </SectionCard>
        </>
      )}
      {role !== 'viewer' && (
        <Drawer open={formOpen} title="Run a corpus" onClose={() => setFormOpen(false)}>
          {formOpen && <RoutingEvalForm onStarted={started} />}
        </Drawer>
      )}
      <RoutingEvalRunDrawer summary={shown} onClose={() => setShown(null)} />
      <ConfirmDialog
        open={deleting != null}
        title="Delete routing run"
        message={
          deleting ? `Delete ${deleting.name} and its stored cases? This cannot be undone.` : ''
        }
        confirmLabel="Delete run"
        onChoice={(yes) => void confirmDelete(yes)}
      />
    </div>
  );
}
