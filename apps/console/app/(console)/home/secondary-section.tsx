'use client';
import { Donut } from '../../../components/charts/donut';
import { BarChart } from '../../../components/charts/bar-chart';
import { ChartFrame } from '../../../components/charts/chart-frame';
import { SectionCard, KeyValueGrid } from '../../../components/ui/section-card';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { ProgressMeter } from '../../../components/charts/meter';
import { EmptyStateV2 } from '../../../components/ui/feedback-v2';
import { formatDuration } from '../../../lib/format';
import { dispositionSlices, failureReasonBars } from './derive';
import type { HomeCall, Loadable } from './types';
import type { InfrastructureSnapshot } from '@winsendotai/ovo-contracts';

export function HomeSecondarySection({
  callsState,
  infrastructureState,
}: {
  callsState: Loadable<HomeCall[]>;
  infrastructureState: Loadable<InfrastructureSnapshot>;
}) {
  const calls = callsState.status === 'ready' ? callsState.data : [];
  const slices = dispositionSlices(calls);
  const failures = failureReasonBars(calls);
  const infra = infrastructureState.status === 'ready' ? infrastructureState.data : undefined;

  return (
    <div className="ds-kpi-strip home-secondary-row">
      <SectionCard title="Outcomes">
        <ChartFrame
          ariaLabel="Calls by disposition"
          height={190}
          loading={callsState.status === 'loading'}
          empty={callsState.status === 'ready' && slices.every((slice) => slice.value === 0)}
          renderChart={() => <Donut slices={slices} centerLabel={String(calls.length)} />}
        />
      </SectionCard>

      <SectionCard title="Top failure reasons" description="Timed-out calls by stage.">
        <ChartFrame
          ariaLabel="Top failure reasons by stage"
          height={190}
          loading={callsState.status === 'loading'}
          empty={callsState.status === 'ready' && failures.length === 0}
          emptyLabel="No timeouts in this range"
          renderChart={(width) => (
            <BarChart
              width={width}
              height={190}
              orientation="horizontal"
              seriesKeys={['count']}
              data={failures}
            />
          )}
        />
      </SectionCard>

      <SectionCard title="Infrastructure health">
        {infrastructureState.status === 'loading' ? (
          <ChartFrame
            ariaLabel="Infrastructure health"
            height={120}
            loading
            renderChart={() => null}
          />
        ) : !infra ? (
          <EmptyStateV2 variant="unavailable" title="Not configured" />
        ) : (
          <div className="stack">
            <StatusBadgeV2 value={infra.installation.status} />
            <ProgressMeter
              label="Worker capacity"
              value={infra.workers.busy ?? 0}
              max={infra.workers.capacityCeiling ?? Math.max(1, infra.workers.total ?? 1)}
              valueLabel={`${infra.workers.busy ?? 0} / ${infra.workers.capacityCeiling ?? infra.workers.total ?? '—'}`}
              tone={infra.installation.status === 'degraded' ? 'warn' : 'ok'}
            />
            <KeyValueGrid
              columns={2}
              items={[
                { label: 'Queue depth', value: infra.queue.depth ?? null },
                {
                  label: 'Oldest job age',
                  value:
                    infra.queue.oldestAgeMs != null
                      ? formatDuration(infra.queue.oldestAgeMs)
                      : null,
                },
              ]}
            />
          </div>
        )}
      </SectionCard>
    </div>
  );
}
