'use client';
import { DataTableV2, type ColumnV2 } from '../../../components/ui/data-table-v2';
import { EmptyStateV2 } from '../../../components/ui/feedback-v2';
import { ProgressMeter } from '../../../components/charts/meter';
import {
  hoursSummary,
  loadLabel,
  releaseLabel,
  utilisationPercent,
  type PoolMember,
} from '../../../lib/derive/routing-pools';
import type { AgentOption, PoolUtilisation } from '../../../lib/types/routing';

/** The members table with live claims; the enabled switch edits in place, the rest in the drawer. */
export function PoolMembers({
  members,
  agents,
  utilisation,
  canEdit,
  onEdit,
  onToggle,
  onRemove,
}: {
  members: readonly PoolMember[];
  agents: readonly AgentOption[];
  utilisation: PoolUtilisation | undefined;
  canEdit: boolean;
  onEdit: (member: PoolMember) => void;
  onToggle: (member: PoolMember, enabled: boolean) => void;
  onRemove: (member: PoolMember) => void;
}) {
  const active = new Map((utilisation?.members ?? []).map((m) => [m.memberId, m.active]));
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const columns: ColumnV2<PoolMember>[] = [
    { id: 'id', header: 'Member', cell: (m) => <strong className="mono">{m.id}</strong> },
    { id: 'agent', header: 'Agent', cell: (m) => `${name(m.agent.agentId)} (${releaseLabel(m)})` },
    { id: 'languages', header: 'Languages', cell: (m) => m.languages.join(', ') },
    {
      id: 'products',
      header: 'Products',
      priority: 'low',
      cell: (m) => m.products.join(', ') || 'Any',
    },
    { id: 'skills', header: 'Skills', priority: 'low', cell: (m) => m.skills.join(', ') || '—' },
    { id: 'priority', header: 'Priority', align: 'end', priority: 'low', cell: (m) => m.priority },
    { id: 'hours', header: 'Hours', priority: 'low', cell: (m) => hoursSummary(m.hours) },
    {
      id: 'load',
      header: 'Active calls',
      cell: (m) => {
        const now = active.get(m.id);
        if (now === undefined) return <span className="muted">Not available</span>;
        return m.capacity ? (
          <ProgressMeter
            label={`${m.id} load`}
            value={now}
            max={m.capacity}
            valueLabel={`${loadLabel(now, m.capacity)} (${utilisationPercent(now, m.capacity)}%)`}
          />
        ) : (
          loadLabel(now, null)
        );
      },
    },
    {
      id: 'enabled',
      header: 'Takes calls',
      cell: (m) => (
        <label className="ds-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label={`${m.id} takes calls`}
            checked={m.enabled}
            disabled={!canEdit}
            onChange={(e) => onToggle(m, e.target.checked)}
          />
          <span className="ds-switch-track" aria-hidden="true" />
          <span>{m.enabled ? 'On' : 'Off'}</span>
        </label>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (m) =>
        canEdit ? (
          <span className="button-row">
            <button
              type="button"
              className="button small"
              aria-label={`Edit member ${m.id}`}
              onClick={() => onEdit(m)}
            >
              Edit
            </button>
            <button
              type="button"
              className="button small danger"
              aria-label={`Remove member ${m.id}`}
              disabled={members.length <= 1}
              onClick={() => onRemove(m)}
            >
              Remove
            </button>
          </span>
        ) : null,
    },
  ];
  return (
    <DataTableV2
      label="Pool members"
      rows={members}
      columns={columns}
      rowKey={(m) => m.id}
      empty={<EmptyStateV2 title="No members">A pool needs at least one agent.</EmptyStateV2>}
    />
  );
}
