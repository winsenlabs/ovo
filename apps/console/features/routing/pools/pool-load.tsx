'use client';
import { ProgressMeter } from '../../../components/charts/meter';
import { EmptyStateV2 } from '../../../components/ui/feedback-v2';
import { SectionCard } from '../../../components/ui/section-card';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { loadLabel, type PoolMember } from '../../../lib/derive/routing-pools';
import type { PoolUtilisation } from '../../../lib/types/routing';

/** Per-member load bars, with a stale chip and retry when the last poll failed. */
export function PoolLoad({
  members,
  data,
  stale,
  unavailable,
  onRetry,
}: {
  members: readonly PoolMember[];
  data: PoolUtilisation | undefined;
  stale: boolean;
  unavailable: boolean;
  onRetry: () => void;
}) {
  return (
    <SectionCard
      title="Live load"
      description="Calls each member holds now, refreshed every 10 seconds."
      actions={
        stale ? (
          <span className="rt-stale">
            <StatusBadgeV2 tone="warn" size="sm" label="Stale" />
            <button type="button" className="button small" onClick={onRetry}>
              Retry
            </button>
          </span>
        ) : undefined
      }
    >
      {data ? (
        <ul className="rt-bars" aria-label="Load per member">
          {members.map((m) => {
            const now = data.members.find((x) => x.memberId === m.id)?.active ?? 0;
            return (
              <li key={m.id}>
                <ProgressMeter label={m.id} value={now} max={m.capacity ?? Math.max(1, now)} valueLabel={loadLabel(now, m.capacity)} />
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyStateV2 variant={unavailable ? 'unavailable' : 'first-run'} title={unavailable ? 'Live load is not available' : 'Loading live load…'} />
      )}
    </SectionCard>
  );
}
