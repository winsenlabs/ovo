'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChangeList } from '../../../components/routing/change-list';
import { DataTableV2, type ColumnV2 } from '../../../components/ui/data-table-v2';
import { EmptyStateV2, ErrorState, InlineAlert } from '../../../components/ui/feedback-v2';
import { SectionCard, IdChip } from '../../../components/ui/section-card';
import { routingApi } from '../../../lib/data/routing-api';
import { useRoutingLoad } from '../../../lib/data/use-routing-load';
import { routingDiff } from '../../../lib/derive/routing-diff';
import { formatDateTime } from '../../../lib/format';
import type { NumberRow, ReleaseSummary, RoutingChange } from '../../../lib/types/routing';

function Compare({ pair }: { pair: [ReleaseSummary, ReleaseSummary] }) {
  const [older, newer] = pair[0].version < pair[1].version ? pair : [pair[1], pair[0]];
  const [changes, setChanges] = useState<RoutingChange[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setChanges(undefined);
    setError(undefined);
    void Promise.all([routingApi.release(older.id), routingApi.release(newer.id)]).then(
      ([a, b]) => live && setChanges(routingDiff(a.snapshot as never, b.snapshot as never)),
      (failure) => live && setError(failure instanceof Error ? failure.message : 'The releases could not be loaded.'),
    );
    return () => {
      live = false;
    };
  }, [older.id, newer.id]);
  return (
    <SectionCard title={`Version ${older.version} to version ${newer.version}`} description="What changed between the two releases.">
      {error ? <ErrorState message={error} /> : changes ? <ChangeList changes={changes} empty="The two releases are identical." /> : <p className="muted" role="status">Loading the releases…</p>}
    </SectionCard>
  );
}

/** Release history, with a two-release comparison and the publish action. */
export function ReleasesTab({
  pointId,
  numbers,
  canEdit,
  refreshKey,
  onPublish,
}: {
  pointId: string;
  numbers: readonly NumberRow[];
  canEdit: boolean;
  refreshKey: number;
  onPublish: () => void;
}) {
  const { state, reload } = useRoutingLoad(() => routingApi.releases(pointId), [pointId, refreshKey]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const rows = state.status === 'ready' ? state.data : [];
  const pair = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const pinned = (id: string) => numbers.filter((n) => n.routingReleaseId === id).length;
  const columns: ColumnV2<ReleaseSummary>[] = [
    { id: 'version', header: 'Version', cell: (r) => <strong>v{r.version}</strong>, sortValue: (r) => r.version },
    { id: 'digest', header: 'Digest', priority: 'low', cell: (r) => <IdChip id={r.digest} short={r.digest.slice(0, 10)} /> },
    { id: 'created', header: 'Created', cell: (r) => formatDateTime(r.createdAt) },
    { id: 'by', header: 'By', priority: 'low', cell: (r) => r.createdBy },
    { id: 'size', header: 'Questions / pools', priority: 'low', align: 'end', cell: (r) => (r.counts ? `${r.counts.nodes} / ${r.counts.pools}` : '—') },
    { id: 'numbers', header: 'Numbers', align: 'end', cell: (r) => pinned(r.id) },
  ];
  return (
    <div className="rt-stack rt-pad">
      <div className="rt-toolbar">
        <p className="muted">A release is an immutable copy of the draft. Numbers keep the release they are bound to until you bind them to a newer one.</p>
        {canEdit && <button type="button" className="button primary" onClick={onPublish}>Publish…</button>}
      </div>
      {selected.size > 2 && <InlineAlert tone="warn">Choose two releases to compare.</InlineAlert>}
      <DataTableV2
        label="Releases"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={state.status === 'loading'}
        error={state.status === 'error' ? state.message : undefined}
        onRetry={() => void reload()}
        selected={selected}
        onSelectChange={setSelected}
        empty={<EmptyStateV2 title="Never published">Publish the draft to give numbers something stable to point at.</EmptyStateV2>}
      />
      {pair.length === 2 && selected.size === 2 && <Compare pair={[pair[0]!, pair[1]!]} />}
      {selected.size === 1 && <p className="muted">Select a second release to see what differs.</p>}
    </div>
  );
}
