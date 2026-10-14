'use client';
import Link from 'next/link';
import { SectionCard } from '../../../components/ui/section-card';
import { EmptyStateV2, Skeleton } from '../../../components/ui/feedback-v2';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { RelativeTime } from '../../../components/ui/display';
import { DataTableV2, type ColumnV2 } from '../../../components/ui/data-table-v2';
import type {
  AttentionItem,
  HomeAgent,
  HomeCall,
  HomeCallback,
  HomeComplaint,
  HomeCredential,
  HomeRatio,
} from './types';
import type { AgentReadiness } from '../../../lib/api';
import type { BudgetSnapshot } from '../../../lib/types/operations';
import { formatMoney } from '../../../lib/format';

const EXPIRY_WARN_DAYS = 14;

function buildAttention(input: {
  agents: readonly HomeAgent[];
  readiness: Map<string, AgentReadiness | undefined>;
  budgets: readonly BudgetSnapshot[];
  complaints: readonly HomeComplaint[];
  ratios: readonly HomeRatio[];
  callbacks: readonly HomeCallback[];
  credentials: readonly HomeCredential[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = Date.now();
  for (const agent of input.agents) {
    const ready = input.readiness.get(agent.id);
    if (ready && !ready.releaseReady)
      items.push({
        id: `agent-${agent.id}`,
        tone: 'warn',
        text: `${agent.config?.name ?? agent.id}: ${ready.blockers.length} release blocker${ready.blockers.length === 1 ? '' : 's'}`,
        href: `/agents/${encodeURIComponent(agent.id)}`,
      });
  }
  for (const budget of input.budgets)
    if (budget.overLimit)
      items.push({
        id: `budget-${budget.id}`,
        tone: 'danger',
        text: `Budget over limit: ${formatMoney(budget.spentPaise)} spent of ${formatMoney(budget.limitPaise)}`,
        href: '/costs',
      });
  for (const complaint of input.complaints)
    if (complaint.overdue)
      items.push({
        id: `complaint-${complaint.id}`,
        tone: 'danger',
        text: `Complaint ${complaint.id} is overdue on ${complaint.overdue === 'ack' ? 'acknowledgement' : 'resolution'}`,
        href: '/operations/compliance',
      });
  for (const ratio of input.ratios)
    if (ratio.level !== 'ok')
      items.push({
        id: `ratio-${ratio.fromNumber}`,
        tone: ratio.level === 'stop' ? 'danger' : 'warn',
        text: `${ratio.fromNumber}: abandoned ratio ${(ratio.abandonedRatio * 100).toFixed(1)}%`,
        href: '/operations/compliance',
      });
  for (const callback of input.callbacks)
    if (Date.parse(callback.dueAt) < now)
      items.push({
        id: `callback-${callback.id}`,
        tone: 'warn',
        text: `Callback overdue since ${new Date(callback.dueAt).toLocaleDateString('en-IN')}`,
        href: '/operations/callbacks',
      });
  for (const credential of input.credentials) {
    if (!credential.expiresAt) continue;
    const daysLeft = (Date.parse(credential.expiresAt) - now) / 86_400_000;
    if (daysLeft <= EXPIRY_WARN_DAYS)
      items.push({
        id: `credential-${credential.id}`,
        tone: daysLeft < 0 ? 'danger' : 'warn',
        text:
          daysLeft < 0
            ? `${credential.label}: credential expired`
            : `${credential.label}: expires in ${Math.ceil(daysLeft)} day${Math.ceil(daysLeft) === 1 ? '' : 's'}`,
        href: '/settings/providers',
      });
  }
  return items;
}

export function HomeAttentionSection(props: {
  loading: boolean;
  agents: readonly HomeAgent[];
  readiness: Map<string, AgentReadiness | undefined>;
  budgets: readonly BudgetSnapshot[];
  complaints: readonly HomeComplaint[];
  ratios: readonly HomeRatio[];
  callbacks: readonly HomeCallback[];
  credentials: readonly HomeCredential[];
  recentCalls: readonly HomeCall[];
  agentNameOf: (agentId?: string) => string;
}) {
  const attention = buildAttention(props);
  const columns: readonly ColumnV2<HomeCall>[] = [
    {
      id: 'agent',
      header: 'Agent',
      priority: 'high',
      cell: (call) => props.agentNameOf(call.agentId),
    },
    { id: 'status', header: 'Status', cell: (call) => <StatusBadgeV2 value={call.status} /> },
    {
      id: 'disposition',
      header: 'Disposition',
      priority: 'low',
      cell: (call) => (call.outcome?.disposition ? call.outcome.disposition : 'None'),
    },
    {
      id: 'started',
      header: 'Started',
      cell: (call) => <RelativeTime value={call.createdAt} />,
    },
  ];

  return (
    <div className="home-attention-row">
      <SectionCard title="Needs attention" padding="flush">
        {props.loading ? (
          <div className="stack" style={{ padding: 'var(--space-4) var(--space-5)' }}>
            <Skeleton shape="line" width="80%" />
            <Skeleton shape="line" width="60%" />
            <Skeleton shape="line" width="70%" />
          </div>
        ) : attention.length === 0 ? (
          <EmptyStateV2 variant="first-run" title="Nothing needs attention right now" />
        ) : (
          <ul className="home-attention-list">
            {attention.map((item) => (
              <li key={item.id}>
                <Link href={item.href} className={`home-attention-item tone-${item.tone}`}>
                  <span className="ds-badge-dot" aria-hidden="true" />
                  {item.text}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Recent calls"
        padding="flush"
        footer={<Link href="/calls">View all calls →</Link>}
      >
        <DataTableV2
          label="Recent calls"
          rows={props.recentCalls}
          columns={columns}
          rowKey={(call) => call.id}
          rowHref={(call) => `/calls/${encodeURIComponent(call.id)}`}
          loading={props.loading}
          empty="No calls yet"
        />
      </SectionCard>
    </div>
  );
}
