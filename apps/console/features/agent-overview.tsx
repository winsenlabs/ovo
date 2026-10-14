'use client';
// The agent's "answer the question above the fold" landing tab (brief §3 "Agent detail /
// studio" > Overview): a KPI strip derived from this agent's own calls and latency cohort, the
// disposition mix, the latest release, release readiness and required-meter coverage. Replaces
// what used to be a bare redirect into the full editor.
import Link from 'next/link';
import { KpiCard, KpiStrip } from '../components/ui/kpi';
import { SectionCard, KeyValueGrid, IdChip } from '../components/ui/section-card';
import { StatusBadgeV2 } from '../components/ui/status-badge';
import { EmptyStateV2, ErrorState } from '../components/ui/feedback-v2';
import { RelativeTime, Duration, Percent } from '../components/ui/display';
import { Donut } from '../components/charts/donut';
import { ChartFrame } from '../components/charts/chart-frame';
import { ProgressMeter } from '../components/charts/meter';
import { RoutedSpeechClipStatus } from '../components/studio/speech-clip-status';
import { useAgentOverview } from '../lib/data/use-agent-overview';
import { humaniseEnum } from '../lib/status';

export function AgentOverviewFeature({ agentId }: { agentId: string }) {
  const overview = useAgentOverview(agentId);

  if (overview.status === 'loading')
    return (
      <KpiStrip>
        <KpiCard label="Calls (7d)" loading />
        <KpiCard label="Completion rate" loading />
        <KpiCard label="Failures (7d)" loading />
        <KpiCard label="First audio (p95)" loading />
      </KpiStrip>
    );
  if (overview.status === 'error')
    return <ErrorState message={overview.message} onRetry={overview.reload} />;

  const data = overview.data;
  const meters = data.requiredMeters;
  const missingMeters = meters?.meters.filter((meter) => meter.status !== 'covered') ?? [];

  return (
    <div className="ui-stack">
      <KpiStrip>
        <KpiCard label="Calls (7d)" value={data.calls7d} />
        <KpiCard
          label="Completion rate"
          value={data.completionRate == null ? null : <Percent value={data.completionRate} />}
          footnote={data.completionRate == null ? 'No terminal calls yet' : undefined}
        />
        <KpiCard
          label="Failures (7d)"
          value={data.failures}
          delta={
            data.timeoutShare != null
              ? { value: Math.round(data.timeoutShare * 100), label: '% timeouts', tone: 'danger' }
              : undefined
          }
        />
        <KpiCard
          label="First audio (p95)"
          value={data.firstAudioP95Ms == null ? null : <Duration ms={data.firstAudioP95Ms} />}
          footnote={data.firstAudioStageLabel ? humaniseEnum(data.firstAudioStageLabel) : undefined}
        />
      </KpiStrip>

      <div className="ui-grid">
        <SectionCard title="Call outcomes (7d)">
          <ChartFrame
            ariaLabel="Call outcomes by disposition"
            // Tall enough for the donut (160px) plus its legend list below it: `ChartFrame`'s
            // sized wrapper clips overflow, and `Donut` renders its legend inside that same
            // wrapper rather than beside the chart proper.
            height={340}
            empty={!data.dispositions.length}
            emptyLabel="No calls in the last 7 days"
            tableRows={data.dispositions.length}
            tableColumns={[
              { header: 'Disposition', cell: (row) => humaniseEnum(data.dispositions[row]!.label) },
              { header: 'Calls', cell: (row) => data.dispositions[row]!.value },
            ]}
            renderChart={() => (
              <Donut
                slices={data.dispositions.map((slice) => ({
                  label: humaniseEnum(slice.label),
                  value: slice.value,
                }))}
                centerLabel={String(data.calls7d)}
              />
            )}
          />
        </SectionCard>

        <SectionCard
          title="Latest release"
          actions={
            data.latestRelease ? (
              <StatusBadgeV2 tone="ok" label="Current" />
            ) : (
              <StatusBadgeV2 tone="neutral" label="None" />
            )
          }
        >
          {data.latestRelease ? (
            <KeyValueGrid
              columns={2}
              items={[
                {
                  label: 'Release',
                  value: (
                    <IdChip id={data.latestRelease.id} short={data.latestRelease.id.slice(0, 12)} />
                  ),
                },
                {
                  label: 'Published',
                  value: <RelativeTime value={data.latestRelease.createdAt} />,
                },
                { label: 'Pinned plugins', value: data.latestRelease.plugins?.length ?? 0 },
                { label: 'Total releases', value: data.releaseCount },
              ]}
            />
          ) : (
            <EmptyStateV2
              variant="first-run"
              title="Never published"
              action={
                <Link
                  className="button primary"
                  href={`/agents/${encodeURIComponent(agentId)}/configure`}
                >
                  Open Configure
                </Link>
              }
            >
              Publish a release once the readiness checklist is clear.
            </EmptyStateV2>
          )}
        </SectionCard>

        <SectionCard
          title="Readiness"
          actions={
            data.readiness ? (
              <StatusBadgeV2
                tone={data.readiness.releaseReady ? 'ok' : 'warn'}
                label={
                  data.readiness.releaseReady
                    ? 'Ready'
                    : `${data.readiness.blockers.length} blockers`
                }
              />
            ) : (
              <StatusBadgeV2 tone="neutral" label="Unknown" />
            )
          }
        >
          {data.readinessError ? (
            <p className="ds-unknown">{data.readinessError}</p>
          ) : data.readiness?.blockers.length ? (
            <ul className="plain-list">
              {data.readiness.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No outstanding blockers.</p>
          )}
          <Link href={`/agents/${encodeURIComponent(agentId)}/configure`}>Open Configure</Link>
        </SectionCard>
      </div>

      <SectionCard
        title="Required meters"
        description="Every billable unit this agent's plugins can emit, and whether a price card covers it."
        actions={
          meters ? (
            <StatusBadgeV2
              tone={meters.complete ? 'ok' : 'warn'}
              label={meters.complete ? 'Every meter priced' : `${missingMeters.length} unpriced`}
            />
          ) : undefined
        }
      >
        {data.requiredMetersError ? (
          <p className="ds-unknown">{data.requiredMetersError}</p>
        ) : meters ? (
          <>
            <ProgressMeter
              label="Meters priced"
              value={meters.meters.length - missingMeters.length}
              max={meters.meters.length || 1}
              valueLabel={`${meters.meters.length - missingMeters.length} of ${meters.meters.length}`}
              tone="ok"
            />
            {missingMeters.length > 0 && (
              <ul className="plain-list">
                {missingMeters.map((meter) => (
                  <li key={meter.key}>
                    {meter.label} · <span className="ds-unknown">{humaniseEnum(meter.status)}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link href={`/agents/${encodeURIComponent(agentId)}/configure#group-cost`}>
              Open Cost
            </Link>
          </>
        ) : (
          <EmptyStateV2 variant="unavailable" title="Required meters are unavailable" />
        )}
      </SectionCard>

      {/* `releases` comes back newest first; `RoutedSpeechClipStatus` wants the opposite. */}
      <RoutedSpeechClipStatus agentId={agentId} releases={[...data.releases].reverse()} />
    </div>
  );
}
