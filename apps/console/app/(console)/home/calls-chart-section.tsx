'use client';
import { useMemo, useState } from 'react';
import { BarChart } from '../../../components/charts/bar-chart';
import { ChartFrame } from '../../../components/charts/chart-frame';
import { SectionCard } from '../../../components/ui/section-card';
import { callsByBucket } from './derive';
import type { HomeCall, Loadable } from './types';

const STATUS_LABEL: Record<string, string> = {
  ok: 'Completed',
  danger: 'Failed',
  info: 'Running',
  neutral: 'Cancelled',
};
const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--ok)',
  danger: 'var(--danger)',
  info: 'var(--info)',
  neutral: 'var(--neutral)',
};

function callsByAgent(
  calls: readonly HomeCall[],
  agentNameOf: (call: { agentId?: string; releaseId?: string }) => string,
) {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = agentNameOf(call);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([category, count]) => ({ category, values: { count } }));
}

export function HomeCallsChartSection({
  callsState,
  rangeDays,
  agentNameOf,
}: {
  callsState: Loadable<HomeCall[]>;
  rangeDays: number;
  agentNameOf: (call: { agentId?: string; releaseId?: string }) => string;
}) {
  const [groupByAgent, setGroupByAgent] = useState(false);
  const calls = callsState.status === 'ready' ? callsState.data : [];
  const byBucket = useMemo(() => callsByBucket(calls, rangeDays), [calls, rangeDays]);
  const byAgent = useMemo(() => callsByAgent(calls, agentNameOf), [calls, agentNameOf]);

  return (
    <SectionCard
      title="Calls over time"
      description={`By status, last ${rangeDays} day${rangeDays === 1 ? '' : 's'}.`}
      actions={
        <div className="ds-range-picker" role="radiogroup" aria-label="Group calls by">
          <button
            type="button"
            role="radio"
            aria-checked={!groupByAgent}
            className={!groupByAgent ? 'selected' : ''}
            onClick={() => setGroupByAgent(false)}
          >
            By status
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={groupByAgent}
            className={groupByAgent ? 'selected' : ''}
            onClick={() => setGroupByAgent(true)}
          >
            By agent
          </button>
        </div>
      }
    >
      <ChartFrame
        ariaLabel={groupByAgent ? 'Calls by agent' : 'Calls over time by status'}
        height={240}
        loading={callsState.status === 'loading'}
        error={callsState.status === 'error' ? callsState.error : undefined}
        empty={callsState.status === 'ready' && calls.length === 0}
        emptyLabel="No calls in this range"
        tableRows={groupByAgent ? byAgent.length : byBucket.length}
        tableColumns={
          groupByAgent
            ? [
                { header: 'Agent', cell: (i) => byAgent[i]?.category },
                { header: 'Calls', cell: (i) => byAgent[i]?.values.count },
              ]
            : [
                { header: 'When', cell: (i) => byBucket[i]?.category },
                ...Object.keys(STATUS_LABEL).map((key) => ({
                  header: STATUS_LABEL[key]!,
                  cell: (i: number) => byBucket[i]?.values[key] ?? 0,
                })),
              ]
        }
        renderChart={(width) =>
          groupByAgent ? (
            <BarChart
              width={width}
              height={240}
              orientation="horizontal"
              seriesKeys={['count']}
              data={byAgent}
            />
          ) : (
            <BarChart
              width={width}
              height={240}
              mode="stacked"
              seriesKeys={Object.keys(STATUS_LABEL)}
              seriesLabel={(key) => STATUS_LABEL[key] ?? key}
              seriesColor={(key) => STATUS_COLOR[key] ?? 'var(--neutral)'}
              data={byBucket}
            />
          )
        }
      />
    </SectionCard>
  );
}
