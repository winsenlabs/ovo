'use client';
import Link from 'next/link';
import { useCursorList } from '../lib/data/use-cursor-list';
import { DataTable } from '../components/ui/data-table';
import { Pagination } from '../components/ui/pagination';
import { PageHeader } from '../components/ui/layout';
import type { AgentDraft } from '../lib/api';

export function AgentListFeature() {
  const page = useCursorList<AgentDraft>('/agents', 50);
  return <div className="ui-stack"><PageHeader title="Agents" eyebrow="Build" description="Draft agents, newest first." actions={<Link className="button primary" href="/agents/new">Create agent</Link>} />
    {page.error && <p role="alert">{page.error}</p>}
    {page.status === 'loading' && <p role="status">Loading agents…</p>}
    <DataTable label="Agents" rows={page.items} rowKey={agent => agent.id} empty="No agents yet"
      columns={[
        { id: 'name', header: 'Name', priority: 'high', cell: agent => <Link className="table-link" href={`/agents/${encodeURIComponent(agent.id)}`}>{agent.config?.name ?? agent.id}</Link> },
        { id: 'mode', header: 'Mode', cell: agent => agent.config?.mode ?? 'Unknown' },
        { id: 'version', header: 'Draft', priority: 'low', cell: agent => agent.draftVersion ?? '—' },
      ]} />
    <Pagination previous={page.hasPrevious} next={page.hasNext} busy={page.status === 'loading'} onPrevious={page.previous} onNext={page.next} />
  </div>;
}
