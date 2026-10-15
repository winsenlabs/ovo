'use client';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { formatDuration, formatPercent } from '../../../lib/format';
import { humaniseEnum } from '../../../lib/status';
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
  // With the calls source down every count below is unknown, not zero (brief §1.4).
  const callsFailed = callsState.status === 'error';
  const known = <T,>(value: T): T | null => (callsFailed ? null : value);
  const unavailable = callsFailed ? 'Calls unavailable' : undefined;

  const perfReady = performanceState.status === 'ready';
  const firstAudio = perfReady ? firstAudioGroup(performanceState.data.groups) : undefined;

  const infraReady = infrastructureState.status === 'ready';
  const activeCalls = infraReady
    ? (infrastructureState.data.telemetry?.activeCalls ?? null)
    : callsFailed
      ? null
      : calls.filter((call) => call.status === 'in_progress').length;

  return (
    <KpiStrip>
      <KpiCard
        label={`Calls (${rangeDays}d)`}
        value={loadingCalls ? undefined : known(kpis.total)}
        loading={loadingCalls}
        footnote={unavailable}
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
          unavailable ??
          (!loadingCalls && kpis.completionRate == null ? 'No finished calls yet' : undefined)
        }
      />
      <KpiCard
        label="Failures / timeouts"
        value={loadingCalls ? undefined : known(kpis.failed)}
        loading={loadingCalls}
        unit={kpis.failed ? 'calls' : undefined}
        footnote={
          unavailable ?? (!loadingCalls && kpis.timeouts ? `${kpis.timeouts} timed out` : undefined)
        }
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
              ? `${(firstAudio.p95Ms / 1000).toFixed(2)} s`
              : null
        }
        loading={performanceState.status === 'loading'}
        footnote={
          firstAudio
            ? `${humaniseEnum(firstAudio.cohort.stage ?? 'unknown')} · last 24h`
            : performanceState.status === 'error'
              ? 'Performance unavailable'
              : 'Not configured'
        }
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
