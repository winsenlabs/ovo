'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '../components/ui/layout';
import { KpiCard, KpiStrip } from '../components/ui/kpi';
import { DataTableV2, type ColumnV2 } from '../components/ui/data-table-v2';
import { StatusBadgeV2 } from '../components/ui/status-badge';
import { EmptyStateV2, ErrorState } from '../components/ui/feedback-v2';
import { FilterBar } from '../components/ui/toolbar';
import { Sparkline } from '../components/charts/sparkline';
import { RelativeTime } from '../components/ui/display';
import { IdChip } from '../components/ui/section-card';
import { useAgentsOverview, type AgentOverviewRow } from '../lib/data/use-agents-overview';

const MODE_LABEL: Record<AgentOverviewRow['mode'], string> = {
  announcement: 'Announcement',
  faq: 'FAQ',
  context: 'Context',
  agent: 'Agent',
};

function readinessBadge(row: AgentOverviewRow) {
  if (row.readinessError) return <StatusBadgeV2 tone="neutral" label="Unknown" />;
  if (!row.readiness) return <StatusBadgeV2 tone="neutral" label="Checking…" />;
  if (row.readiness.releaseReady) return <StatusBadgeV2 tone="ok" label="Ready" />;
  const count = row.readiness.blockers.length;
  return <StatusBadgeV2 tone="warn" label={`${count} blocker${count === 1 ? '' : 's'}`} />;
}

export function AgentListFeature() {
  const overview = useAgentsOverview();
  const [search, setSearch] = useState('');

  const rows = overview.status === 'ready' ? overview.rows : [];
  const filtered = useMemo(
    () =>
      search.trim()
        ? rows.filter((row) => row.name.toLowerCase().includes(search.trim().toLowerCase()))
        : rows,
    [rows, search],
  );

  const columns: ColumnV2<AgentOverviewRow>[] = [
    {
      id: 'name',
      header: 'Name',
      priority: 'high',
      sortValue: (row) => row.name.toLowerCase(),
      cell: (row) => (
        <span className="ui-cluster">
          <strong>{row.name}</strong>
          <StatusBadgeV2 tone="neutral" size="sm" label={MODE_LABEL[row.mode]} />
        </span>
      ),
    },
    { id: 'readiness', header: 'Readiness', cell: readinessBadge },
    {
      id: 'release',
      header: 'Latest release',
      priority: 'low',
      cell: (row) =>
        row.latestRelease ? (
          <span className="ui-cluster">
            <IdChip id={row.latestRelease.id} short={row.latestRelease.id.slice(0, 10)} />
            <RelativeTime value={row.latestRelease.createdAt} />
          </span>
        ) : (
          <span className="ds-unknown">No releases</span>
        ),
    },
    {
      id: 'stack',
      header: 'Voice stack',
      priority: 'low',
      cell: (row) =>
        row.voiceStack.length ? (
          <span className="ui-cluster">
            {row.voiceStack.map((chip) => (
              <span className="ds-chip" key={chip.slot}>
                {chip.label}
              </span>
            ))}
          </span>
        ) : (
          <span className="ds-unknown">Not configured</span>
        ),
    },
    { id: 'language', header: 'Language', priority: 'low', cell: (row) => row.language },
    {
      id: 'calls',
      header: 'Calls (7d)',
      align: 'end',
      sortValue: (row) => row.calls7d,
      cell: (row) => (
        <span className="ui-cluster" style={{ justifyContent: 'flex-end' }}>
          <span className="mono">{row.calls7d}</span>
          {row.callsSparkline.some((value) => value > 0) && (
            <Sparkline values={row.callsSparkline} width={56} height={20} />
          )}
        </span>
      ),
    },
    {
      id: 'updated',
      header: 'Updated',
      // Not `low`: `low`-priority columns disappear on a narrow viewport (`.ds-table` mobile
      // cards), and the verifier's "Updated" column was the one piece of context a mobile card
      // dropped entirely.
      align: 'end',
      sortValue: (row) => row.updatedAt ?? '',
      cell: (row) => <RelativeTime value={row.updatedAt} />,
    },
  ];

  return (
    <div className="ui-stack">
      <PageHeader
        eyebrow="Build"
        title="Agents"
        description="Every voice agent on this workspace, its release readiness and what it costs to run."
        actions={
          <Link className="button primary" href="/agents/new">
            Create agent
          </Link>
        }
        onRefresh={overview.reload}
        refreshing={overview.status === 'loading'}
      />
      {overview.status === 'ready' && (
        <KpiStrip>
          <KpiCard label="Agents" value={overview.totals.agents} />
          <KpiCard label="With a published release" value={overview.totals.withRelease} />
          <KpiCard label="Release-blocked" value={overview.totals.blocked} />
          <KpiCard label="Calls (24h)" value={overview.totals.calls24h} />
        </KpiStrip>
      )}
      {overview.status === 'loading' && (
        <KpiStrip>
          <KpiCard label="Agents" loading />
          <KpiCard label="With a published release" loading />
          <KpiCard label="Release-blocked" loading />
          <KpiCard label="Calls (24h)" loading />
        </KpiStrip>
      )}
      {overview.status === 'error' ? (
        <ErrorState message={overview.message} onRetry={overview.reload} />
      ) : (
        <>
          <FilterBar
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search agents by name"
          />
          <DataTableV2
            // `DataTableV2` calls `useRef`/`useEffect` only after its loading/empty early
            // returns, so remounting on `status` alone (the previous workaround) covered the
            // loading transition but not rows going to empty on a search with no matches — that
            // second transition tripped the same hook-count mismatch (React #300/#310). Keying on
            // whether the table is *currently* empty as well forces a clean remount across both
            // transitions. Foundation request: move those two hooks above the early returns so no
            // caller needs this key at all.
            key={`${overview.status}:${filtered.length === 0}`}
            label="Agents"
            rows={filtered}
            rowKey={(row) => row.id}
            rowHref={(row) => `/agents/${encodeURIComponent(row.id)}`}
            loading={overview.status === 'loading'}
            columns={columns}
            empty={
              search.trim() ? (
                <EmptyStateV2
                  variant="filtered"
                  title="No agents match this search"
                  action={
                    <button type="button" className="text-button" onClick={() => setSearch('')}>
                      Clear search
                    </button>
                  }
                />
              ) : (
                <EmptyStateV2
                  variant="first-run"
                  title="No agents yet"
                  action={
                    <Link className="button primary" href="/agents/new">
                      Create agent
                    </Link>
                  }
                >
                  Create the first voice agent to pick its plugins and publish a release.
                </EmptyStateV2>
              )
            }
          />
        </>
      )}
    </div>
  );
}
