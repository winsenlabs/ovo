'use client';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useState } from 'react';
import { useCursorList } from '../lib/data/use-cursor-list';
import { timeoutOf, type CallOutcomeSummary } from '@winsendotai/ovo-contracts';
import type { CallSummary } from '../lib/api';
import { useSession } from '../components/shell/session-provider';
import { LiveCallForm } from '../components/operations/live-call-form';
import { Drawer } from '../components/ui/drawer';
import { DataTable } from '../components/ui/data-table';
import { Pagination } from '../components/ui/pagination';
import { PageHeader } from '../components/ui/layout';
import { Time } from '../components/ui/button';
import { StatusBadge } from '../components/ui/feedback';

const filters = ['agentId', 'engine', 'carrier', 'kind', 'status'] as const;
/** The API attaches each call's recorded outcome (AGT-8), or null when none was recorded. */
type CallRow = CallSummary & { outcome?: CallOutcomeSummary | null };
export function CallsIndexFeature() {
  const identity = useSession();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [launchOpen, setLaunchOpen] = useState(false);
  const query = new URLSearchParams();
  for (const filter of filters) {
    const value = search.get(filter);
    if (value) query.set(filter, value);
  }
  query.set('order', 'desc');
  const page = useCursorList<CallRow>(`/calls?${query}`, 50);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('cursor');
    router.push(`${pathname}?${next}`);
  };
  return (
    <div className="ui-stack">
      <PageHeader
        eyebrow="Evidence"
        title="Calls"
        description="Newest calls first. Filters are stored in the URL."
        actions={
          identity.role === 'admin' && (
            <button className="button" onClick={() => setLaunchOpen(true)}>
              Launch live call
            </button>
          )
        }
      />
      <div className="ui-grid">
        {filters.map((key) => (
          <label key={key}>
            {key}
            <input
              value={search.get(key) ?? ''}
              onChange={(event) => setFilter(key, event.target.value)}
            />
          </label>
        ))}
      </div>
      {page.error && <p role="alert">{page.error}</p>}
      {page.status === 'loading' && <p role="status">Loading calls…</p>}
      <DataTable
        label="Calls"
        rows={page.items}
        rowKey={(call) => call.id}
        empty="No calls match these filters"
        columns={[
          {
            id: 'id',
            header: 'Call',
            priority: 'high',
            cell: (call) => (
              <Link className="table-link mono" href={`/calls/${encodeURIComponent(call.id)}`}>
                {call.id}
              </Link>
            ),
          },
          { id: 'kind', header: 'Kind', cell: (call) => call.kind ?? 'Unknown' },
          { id: 'status', header: 'Status', cell: (call) => call.status ?? 'Unknown' },
          {
            id: 'disposition',
            header: 'Disposition',
            cell: (call) => call.outcome?.disposition ?? '—',
          },
          {
            id: 'final-node',
            header: 'Final node',
            priority: 'low',
            cell: (call) => call.outcome?.finalNode ?? '—',
          },
          {
            id: 'ended',
            header: 'Ended',
            priority: 'low',
            cell: (call) => <EndReason reason={call.outcome?.endReason} />,
          },
          {
            id: 'when',
            header: 'Started',
            priority: 'low',
            cell: (call) => <Time value={call.createdAt} />,
          },
        ]}
      />
      <Pagination
        previous={page.hasPrevious}
        next={page.hasNext}
        busy={page.status === 'loading'}
        onPrevious={page.previous}
        onNext={page.next}
      />
      {identity.role === 'admin' && (
        <Drawer open={launchOpen} title="Launch live call" onClose={() => setLaunchOpen(false)}>
          <LiveCallForm
            role="admin"
            onLaunched={async () => {
              setLaunchOpen(false);
              await page.refresh();
            }}
          />
        </Drawer>
      )}
    </div>
  );
}

/** OBS-9: a call that timed out says which stage did, not just that it failed. */
function EndReason({ reason }: { reason?: string | null }) {
  if (!reason) return <>—</>;
  const timeout = timeoutOf(reason);
  if (!timeout) return <span className="mono">{reason.split(':', 2).join(':')}</span>;
  return (
    <StatusBadge tone="danger">
      timeout: {timeout.stage}
      {timeout.provider ? ` (${timeout.provider})` : ''}
    </StatusBadge>
  );
}
