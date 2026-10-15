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
import { formatRelativeTime } from '../../lib/format';
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
  // `compareByBars` reads straight off the cohort, which for 'agent'/'release' is an opaque ID —
  // the brief's agent/release names are already loaded for the filter bar, so resolve the two ID
  // dimensions to names here instead of showing `agt_…`/`rel_…` (verifier minor #13).
  const agentNameById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const releaseNameById = useMemo(
    () =>
      new Map(
        releases.map((release) => [release.id, `${release.agentName} · ${release.id.slice(0, 8)}`]),
      ),
    [releases],
  );
  const compareBars = useMemo(() => {
    const bars = compareByBars(compareGroups, compareDimension);
    const nameById =
      compareDimension === 'agent'
        ? agentNameById
        : compareDimension === 'release'
          ? releaseNameById
          : null;
    return nameById
      ? bars.map((bar) => ({ ...bar, category: nameById.get(bar.category) ?? bar.category }))
      : bars;
  }, [compareGroups, compareDimension, agentNameById, releaseNameById]);
  const dropped = primary?.ingestion?.dropped ?? 0;
  // "Which bucket are these KPI values from" — the dominant stage can legitimately flip between
  // loads as sample counts shift, so the KPI strip always names its own moment in time instead of
  // leaving the operator to guess whether it is live or stale (verifier minor #20).
  const latestAt = latest?.cohort.time
    ? `As of ${formatRelativeTime(latest.cohort.time)}`
    : undefined;

  const toggleStage = (key: string) =>
    setHiddenStages((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Insights"
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
              footnote={latestAt}
            />
            <KpiCard
              label={stage ? `${humaniseEnum(stage)} · p95` : 'p95'}
              value={latest?.p95Ms != null ? formatMsAxis(latest.p95Ms) : null}
              loading={primary === null}
              footnote={latestAt}
            />
            <KpiCard
              label={stage ? `${humaniseEnum(stage)} · p99` : 'p99'}
              value={latest?.p99Ms != null ? formatMsAxis(latest.p99Ms) : null}
              loading={primary === null}
              footnote={latestAt}
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
          {/* "Compare by" is the summary view (which cohort looks off); "Cohort detail" is the
              deep raw table behind a "Show table" toggle. Reading top-to-bottom, the summary
              belongs before the raw detail (verifier minor #20). */}
          <PerformanceComparePanel
            dimension={compareDimension}
            onDimensionChange={setCompareDimension}
            bars={compareBars}
            loading={compareLoading}
            error={compareError}
            onRetry={loadCompare}
          />
          <PerformanceDetailTable
            stageGroups={stageOnly}
            cohortGroups={groups}
            loading={primary === null}
            error={primaryError}
            onRetry={loadPrimary}
          />
        </>
      )}
    </div>
  );
}
