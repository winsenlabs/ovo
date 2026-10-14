'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  compareByBars,
  distinctCohortValues,
  dominantStage,
  latestBucketFor,
  rangeTotals,
  resolvePerformanceRange,
  stageTimeSeries,
  type CompareDimension,
  type Percentile,
} from '../../lib/derive/performance';
import { humaniseEnum } from '../../lib/status';
import { formatMsAxis } from '../charts/scale';
import { PageHeader } from '../ui/layout';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { EmptyStateV2, InlineAlert } from '../ui/feedback-v2';
import {
  loadAgentChoices,
  loadAgentReleaseOptions,
  type ReleaseOption,
} from './agent-release-options';
import {
  PerformanceFilterBar,
  type PerformanceFilters,
  type PerformanceSource,
} from './performance-filters';
import { PerformanceComparePanel } from './performance-compare-panel';
import { PerformanceDetailTable } from './performance-detail-table';
import { PerformanceLatencyChart } from './performance-latency-chart';
import { usePerformanceQueries } from './use-performance-queries';
import type { CustomRange, RangePreset } from '../ui/toolbar';

const emptyFilters: PerformanceFilters = {
  agentId: '',
  releaseId: '',
  provider: '',
  model: '',
  language: '',
  stage: '',
};

/**
 * Performance: one range-and-source toolbar, a KPI strip for the busiest stage, a multi-series
 * latency line, a stage breakdown, a "compare by" view, and the cohort table — instead of a
 * truncated 100-row dump with no chart (brief defects #1, #13).
 */
export function PerformanceView() {
  const [preset, setPreset] = useState<RangePreset>('24h');
  const [custom, setCustom] = useState<CustomRange>({ from: '', to: '' });
  const [source, setSource] = useState<PerformanceSource>('all');
  const [filters, setFilters] = useState<PerformanceFilters>(emptyFilters);
  const [percentile, setPercentile] = useState<Percentile>('p95Ms');
  const [hiddenStages, setHiddenStages] = useState<ReadonlySet<string>>(new Set());
  const [compareDimension, setCompareDimension] = useState<CompareDimension>('provider');

  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [releases, setReleases] = useState<ReleaseOption[]>([]);
  useEffect(() => {
    void loadAgentChoices()
      .then(setAgents)
      .catch(() => setAgents([]));
    void loadAgentReleaseOptions()
      .then(setReleases)
      .catch(() => setReleases([]));
  }, []);

  const { fromMs, toMs } = useMemo(() => resolvePerformanceRange(preset, custom), [preset, custom]);
  const {
    primary,
    primaryError,
    stageOnly,
    compareGroups,
    compareError,
    compareLoading,
    allGroups,
    loadPrimary,
    loadCompare,
  } = usePerformanceQueries({ fromMs, toMs, filters, source, compareDimension });

  const groups = primary?.groups ?? [];
  const stage = dominantStage(groups);
  const latest = latestBucketFor(groups, stage);
  const totals = rangeTotals(groups, stage);
  const series = useMemo(() => stageTimeSeries(groups, percentile), [groups, percentile]);
  const compareBars = useMemo(
    () => compareByBars(compareGroups, compareDimension),
    [compareGroups, compareDimension],
  );
  const dropped = primary?.ingestion?.dropped ?? 0;

  const toggleStage = (key: string) =>
    setHiddenStages((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Operational evidence"
        title="Performance"
        description="Bounded latency cohorts from durable telemetry. Missing samples remain unavailable, never zero."
      />
      <PerformanceFilterBar
        range={preset}
        onRangeChange={setPreset}
        custom={custom}
        onCustomChange={setCustom}
        source={source}
        onSourceChange={setSource}
        filters={filters}
        onFiltersChange={setFilters}
        agents={agents}
        releases={releases}
        providers={distinctCohortValues(allGroups, 'provider')}
        models={distinctCohortValues(allGroups, 'model')}
        languages={distinctCohortValues(allGroups, 'language')}
        stages={distinctCohortValues(allGroups, 'stage')}
      />
      {primary?.truncated && (
        <InlineAlert tone="warn">
          The query matched more cohorts than fit in one response. Narrow the range or filters to
          see the rest.
        </InlineAlert>
      )}
      {dropped > 0 && (
        <InlineAlert tone="warn">
          {dropped} telemetry events were dropped during ingestion and are not represented below.
        </InlineAlert>
      )}
      {primary?.ingestion?.closed && (
        <InlineAlert tone="info">Ingestion is closed for this installation.</InlineAlert>
      )}
      {primaryError ? (
        <EmptyStateV2 variant="unavailable" title="Performance telemetry unavailable">
          {primaryError}
        </EmptyStateV2>
      ) : (
        <>
          <KpiStrip>
            <KpiCard
              label={stage ? `${humaniseEnum(stage)} · p50` : 'p50'}
              value={latest?.p50Ms != null ? formatMsAxis(latest.p50Ms) : null}
              loading={primary === null}
            />
            <KpiCard
              label={stage ? `${humaniseEnum(stage)} · p95` : 'p95'}
              value={latest?.p95Ms != null ? formatMsAxis(latest.p95Ms) : null}
              loading={primary === null}
            />
            <KpiCard
              label={stage ? `${humaniseEnum(stage)} · p99` : 'p99'}
              value={latest?.p99Ms != null ? formatMsAxis(latest.p99Ms) : null}
              loading={primary === null}
            />
            <KpiCard label="Calls in range" value={totals.calls} loading={primary === null} />
            <KpiCard
              label="Errors / timeouts"
              value={`${totals.errors} / ${totals.timeouts}`}
              loading={primary === null}
            />
          </KpiStrip>
          <PerformanceLatencyChart
            groups={groups}
            series={series}
            hiddenStages={hiddenStages}
            onToggleStage={toggleStage}
            percentile={percentile}
            onPercentileChange={setPercentile}
            loading={primary === null}
          />
          <PerformanceDetailTable
            stageGroups={stageOnly}
            cohortGroups={groups}
            loading={primary === null}
            error={primaryError}
            onRetry={loadPrimary}
          />
          <PerformanceComparePanel
            dimension={compareDimension}
            onDimensionChange={setCompareDimension}
            bars={compareBars}
            loading={compareLoading}
            error={compareError}
            onRetry={loadCompare}
          />
        </>
      )}
    </div>
  );
}
