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
import { RelativeTime, Percent } from '../components/ui/display';
import { Donut } from '../components/charts/donut';
import { ChartFrame } from '../components/charts/chart-frame';
import { RoutedSpeechClipStatus } from '../components/studio/speech-clip-status';
import { useAgentOverview } from '../lib/data/use-agent-overview';
import { humaniseEnum } from '../lib/status';
import { formatP95Duration } from '../lib/derive/overview-text';
import { ReadinessCard, RequiredMetersCard } from './agent-overview-cards';

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
  // `requiredMeters` comes back from its own, independently-failable fetch (see
  // `use-agent-overview.ts`): an unexpected payload shape must drop this one card, not the whole
  // tab the way `meters.meters.filter` with no guard did (React #300 on any `/required-meters`
  // response that omits `meters`).
  const meters = data.requiredMeters;
  const missingMeters = meters?.meters?.filter((meter) => meter.status !== 'covered') ?? [];
  const dispositions = data.dispositions ?? [];
  const releases = data.releases ?? [];

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
          // Not `delta`: `KpiCard` always inserts a literal space before a delta's label
          // (`` `${value} ${label}` ``), which read as a stray "100 % timeouts" no matter how the
          // label string itself was spaced. A footnote has no such template to fight.
          footnote={
            data.timeoutShare != null && data.timeoutShare > 0
              ? // Rounding to a whole percent can round down to 0 while `timeoutShare` is still
                // > 0 (e.g. 0.3%); `timeoutShare > 0` is the honest "there are some" signal — the
                // number itself still rounds for display.
                `${Math.round(data.timeoutShare * 100)}% timeouts`
              : undefined
          }
        />
        <KpiCard
          label="First audio (p95)"
          value={
            data.firstAudioP95Ms == null ? null : (
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatP95Duration(data.firstAudioP95Ms)}
              </span>
            )
          }
          footnote={data.firstAudioStageLabel ? humaniseEnum(data.firstAudioStageLabel) : undefined}
        />
      </KpiStrip>

      {/* `alignSelf: 'start'` on every card here: `.ui-grid`'s row otherwise stretches every card
          to the tallest one's height and (per the card body's own vertical-center rule) centres
          short content inside that borrowed height — the donut card ended up ~200px taller than
          its own content, and "Latest release"/"Readiness" read as a big empty box around a few
          lines of text. Sizing each card to its own content instead also lines up their top edges,
          which the shared stretch-to-row-height behaviour did not. */}
      <div className="ui-grid">
        <div style={{ alignSelf: 'start' }}>
          <SectionCard title="Call outcomes (7d)">
            <ChartFrame
              ariaLabel="Call outcomes by disposition"
              // Tall enough for the donut (160px) plus its legend list below it: `ChartFrame`'s
              // sized wrapper clips overflow, and `Donut` renders its legend inside that same
              // wrapper rather than beside the chart proper.
              height={340}
              empty={!dispositions.length}
              emptyLabel="No calls in the last 7 days"
              tableRows={dispositions.length}
              tableColumns={[
                { header: 'Disposition', cell: (row) => humaniseEnum(dispositions[row]!.label) },
                { header: 'Calls', cell: (row) => dispositions[row]!.value },
              ]}
              renderChart={() => (
                <Donut
                  slices={dispositions.map((slice) => ({
                    label: humaniseEnum(slice.label),
                    value: slice.value,
                  }))}
                  centerLabel={String(data.calls7d)}
                />
              )}
            />
          </SectionCard>
        </div>

        <div style={{ alignSelf: 'start' }}>
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
                      <IdChip
                        id={data.latestRelease.id}
                        short={data.latestRelease.id.slice(0, 12)}
                      />
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
        </div>

        <div style={{ alignSelf: 'start' }}>
          <ReadinessCard
            agentId={agentId}
            readiness={data.readiness}
            readinessError={data.readinessError}
          />
        </div>
      </div>

      <RequiredMetersCard
        agentId={agentId}
        meters={meters}
        missingMeters={missingMeters}
        requiredMetersError={data.requiredMetersError}
      />

      {/* `releases` comes back newest first; `RoutedSpeechClipStatus` wants the opposite. */}
      <RoutedSpeechClipStatus agentId={agentId} releases={[...releases].reverse()} />
    </div>
  );
}
