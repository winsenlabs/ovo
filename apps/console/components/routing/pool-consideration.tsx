import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { loadLabel } from '../../lib/derive/routing-pools';
import type { PoolConsideration, PoolExplanation } from '../../lib/types/routing-simulate';

type Member = PoolConsideration['members'][number];
const REASON: Record<Member['reasons'][number], string> = {
  disabled: 'Turned off',
  closed: 'Closed now',
  product: 'Other product',
  skill: 'Missing skill',
  language: 'Wrong language',
  full: 'At capacity',
  fault: 'Made unavailable',
};
const RESULT: Record<PoolConsideration['result'], { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  picked: { label: 'Picked a member', tone: 'ok' },
  queued: { label: 'Queued for a member', tone: 'warn' },
  pool_full: { label: 'Every member is full', tone: 'warn' },
  no_eligible_member: { label: 'No eligible member', tone: 'danger' },
};

const columns: ColumnV2<Member>[] = [
  { id: 'member', header: 'Member', cell: (m) => <strong className="mono">{m.memberId}</strong> },
  {
    id: 'eligible',
    header: 'Eligible',
    cell: (m) => (
      <span className="rt-badges">
        <StatusBadgeV2 tone={m.picked ? 'ok' : m.eligible ? 'info' : 'neutral'} size="sm" label={m.picked ? 'Picked' : m.eligible ? `Eligible (tier ${(m.tier ?? 0) + 1})` : 'Not eligible'} />
        {m.reasons.map((r) => <StatusBadgeV2 key={r} tone="warn" size="sm" label={REASON[r]} />)}
      </span>
    ),
  },
  { id: 'priority', header: 'Priority', align: 'end', priority: 'low', cell: (m) => m.priority },
  { id: 'load', header: 'Active calls', align: 'end', cell: (m) => loadLabel(m.active, m.capacity) },
];

/** Why a pool did or did not pick each member: eligibility and the reasons, member by member. */
export function PoolConsiderationCard({ pool }: { pool: PoolConsideration | (PoolExplanation & { turn?: null; node?: null }) }) {
  const result = RESULT[pool.result];
  return (
    <section className="rt-card" aria-label={`Pool ${pool.poolName}`}>
      <div className="rt-card-head">
        <h4>
          {pool.poolName}
          {pool.node && <span className="muted"> from {pool.node}</span>}
        </h4>
        <StatusBadgeV2 tone={result.tone} size="sm" label={result.label} />
      </div>
      <p className="muted">
        Wanted: language {pool.wanted.language ?? 'any'} ({pool.wanted.languageMode === 'caller' ? "the caller's" : 'any'})
        {pool.languageUsed && pool.languageUsed !== pool.wanted.language ? `, served in ${pool.languageUsed}` : ''}
        {pool.wanted.products?.length ? `, product ${pool.wanted.products.join(' / ')}` : ''}
        {pool.wanted.skills.length ? `, skills ${pool.wanted.skills.join(', ')}` : ''}.
      </p>
      <DataTableV2 label={`Members of ${pool.poolName}`} rows={pool.members} columns={columns} rowKey={(m) => m.memberId} density="compact" />
    </section>
  );
}
