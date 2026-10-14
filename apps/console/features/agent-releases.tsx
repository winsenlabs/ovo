'use client';
import { useEffect, useState } from 'react';
import { apiRequest, items, type Release } from '../lib/api';
import { PageHeader } from '../components/ui/layout';
import { IdChip } from '../components/ui/section-card';
import { StatusBadgeV2 } from '../components/ui/status-badge';
import { ErrorState, EmptyStateV2, Skeleton } from '../components/ui/feedback-v2';
import { RelativeTime } from '../components/ui/display';
import { DataTableV2, type ColumnV2 } from '../components/ui/data-table-v2';
import { RoutedSpeechClipStatus, loadRouted } from '../components/studio/speech-clip-status';

type ReleaseRow = Release & { current: boolean; liveOn: string[] };

export function AgentReleasesFeature({ agentId }: { agentId: string }) {
  const [releases, setReleases] = useState<Release[]>();
  const [liveOn, setLiveOn] = useState<Map<string, string[]>>(new Map());
  const [error, setError] = useState<string>();

  const load = () => {
    setError(undefined);
    void apiRequest<unknown>(`/agents/${encodeURIComponent(agentId)}/releases`)
      .then(({ data }) => setReleases(items(data)))
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'Releases unavailable'),
      );
    void loadRouted().then(setLiveOn, () => setLiveOn(new Map()));
  };
  useEffect(load, [agentId]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!releases)
    return (
      <div className="ui-stack">
        <Skeleton shape="block" />
      </div>
    );

  // Newest first, as the API lists them (confirmed against the fixture); the newest (and only
  // the newest) is "Current".
  const rows: ReleaseRow[] = releases.map((release, index) => ({
    ...release,
    current: index === 0,
    liveOn: liveOn.get(release.id) ?? [],
  }));
  const columns: ColumnV2<ReleaseRow>[] = [
    {
      id: 'id',
      header: 'Release',
      cell: (row) => (
        <span className="ui-cluster">
          <IdChip id={row.id} short={row.id.slice(0, 12)} />
          {row.current && <StatusBadgeV2 tone="ok" size="sm" label="Current" />}
        </span>
      ),
    },
    {
      id: 'created',
      header: 'Created',
      sortValue: (row) => row.createdAt,
      cell: (row) => <RelativeTime value={row.createdAt} />,
    },
    {
      id: 'plugins',
      header: 'Plugins',
      align: 'end',
      sortValue: (row) => row.plugins?.length ?? 0,
      cell: (row) => row.plugins?.length ?? 0,
    },
    {
      id: 'live-on',
      header: 'Live on',
      cell: (row) =>
        row.liveOn.length ? (
          <span className="ui-cluster">
            {row.liveOn.map((via) => (
              <span className="ds-chip" key={via}>
                {via}
              </span>
            ))}
          </span>
        ) : (
          <span className="ds-unknown">Not routed</span>
        ),
    },
  ];

  return (
    <div className="ui-stack">
      <PageHeader
        title="Releases"
        description="Immutable published configurations, newest first, and what currently routes to each."
      />
      {/* `releases` comes back newest first; `RoutedSpeechClipStatus` wants the opposite. */}
      <RoutedSpeechClipStatus agentId={agentId} releases={[...releases].reverse()} />
      <DataTableV2
        label="Releases"
        rows={rows}
        rowKey={(row) => row.id}
        columns={columns}
        empty={<EmptyStateV2 variant="first-run" title="No releases yet" />}
      />
    </div>
  );
}
