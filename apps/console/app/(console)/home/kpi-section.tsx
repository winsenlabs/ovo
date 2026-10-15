'use client';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { formatDuration, formatPercent } from '../../../lib/format';
import { callKpis, callsByBucket, firstAudioGroup } from './derive';
import type { HomeCall, Loadable } from './types';
import type { PerformanceResult } from '../../../lib/types/operations';
import type { InfrastructureSnapshot } from '@winsendotai/ovo-contracts';

function sparklineOf(calls: readonly HomeCall[], rangeDays: number): number[] {
  return callsByBucket(calls, rangeDays).map((bucket) =>
    Object.values(bucket.values).reduce((sum, value) => sum + value, 0),
  );
}

export function HomeKpiSection({
  callsState,
  performanceState,
  infrastructureState,
  rangeDays,
}: {
  callsState: Loadable<HomeCall[]>;
  performanceState: Loadable<PerformanceResult>;
  infrastructureState: Loadable<InfrastructureSnapshot>;
  rangeDays: number;
}) {
  const calls = callsState.status === 'ready' ? callsState.data : [];
  const kpis = callKpis(calls);
  const sparkline = callsState.status === 'ready' ? sparklineOf(calls, rangeDays) : [];
  const loadingCalls = callsState.status === 'loading';

  const perfReady = performanceState.status === 'ready';
  const firstAudio = perfReady ? firstAudioGroup(performanceState.data.groups) : undefined;

  const infraReady = infrastructureState.status === 'ready';
  const activeCalls = infraReady
    ? (infrastructureState.data.telemetry?.activeCalls ?? null)
    : calls.filter((call) => call.status === 'in_progress').length;

  return (
    <KpiStrip>
      <KpiCard
        label={`Calls (${rangeDays}d)`}
        value={loadingCalls ? undefined : kpis.total}
        loading={loadingCalls}
        sparkline={sparkline.length > 1 ? sparkline : undefined}
        href="/calls"
      />
      <KpiCard
        label="Completion rate"
        value={
          loadingCalls
            ? undefined
            : kpis.completionRate != null
              ? formatPercent(kpis.completionRate)
              : null
        }
        loading={loadingCalls}
        footnote={
          !loadingCalls && kpis.completionRate == null ? 'No finished calls yet' : undefined
        }
      />
      <KpiCard
        label="Failures / timeouts"
        value={loadingCalls ? undefined : kpis.failed}
        loading={loadingCalls}
        unit={kpis.failed ? 'calls' : undefined}
        footnote={!loadingCalls && kpis.timeouts ? `${kpis.timeouts} timed out` : undefined}
        href="/calls?status=failed"
      />
      <KpiCard
        label="Median call duration"
        value={
          loadingCalls
            ? undefined
            : kpis.medianDurationMs != null
              ? formatDuration(kpis.medianDurationMs)
              : null
        }
        loading={loadingCalls}
      />
      <KpiCard
        label="First-audio p95"
        value={
          performanceState.status === 'loading'
            ? undefined
            : firstAudio?.p95Ms != null
              ? formatDuration(firstAudio.p95Ms)
              : null
        }
        loading={performanceState.status === 'loading'}
        footnote={firstAudio ? `Stage: ${firstAudio.cohort.stage ?? 'unknown'}` : 'Not configured'}
        href="/performance"
      />
      <KpiCard
        label="Active calls now"
        value={infrastructureState.status === 'loading' && !loadingCalls ? undefined : activeCalls}
        loading={infrastructureState.status === 'loading' && loadingCalls}
        href="/infrastructure"
      />
    </KpiStrip>
  );
}
