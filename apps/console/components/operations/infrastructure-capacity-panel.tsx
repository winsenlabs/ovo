import type { InfrastructureSnapshot } from '../../lib/operator-api';
import { capacitySegments, isStale } from '../../lib/derive/infrastructure';
import { formatDuration } from '../../lib/format';
import { KeyValueGrid, SectionCard } from '../ui/section-card';
import { ProgressMeter } from '../charts/meter';
import { StatusBadgeV2 } from '../ui/status-badge';
import { EmptyStateV2 } from '../ui/feedback-v2';

/**
 * Worker capacity as a stacked meter against the ceiling, plus the dispatcher's own
 * required-vs-provisioned signal (`capacity.lastSignal`) — the brief's "capacity signal is not
 * shown at all" defect — with a staleness badge once the signal is older than `maxAgeMs`.
 */
export function InfrastructureCapacityPanel({ snapshot }: { snapshot: InfrastructureSnapshot }) {
  const { segments, max } = capacitySegments(snapshot.workers);
  const signal = snapshot.capacity.lastSignal;
  const stale = isStale(snapshot.capacity.ageMs, snapshot.capacity.maxAgeMs);
  return (
    <div className="ds-stack">
      <SectionCard
        title="Worker capacity"
        description="Busy, reserved and ready workers against the capacity ceiling."
      >
        {max > 0 ? (
          <ProgressMeter
            label="Workers"
            segments={segments}
            max={max}
            valueLabel={`${snapshot.workers.active ?? 0} active of ${max} capacity`}
          />
        ) : (
          <EmptyStateV2 variant="unavailable" title="Capacity unknown">
            No fresh worker capacity sample was reported.
          </EmptyStateV2>
        )}
      </SectionCard>
      <SectionCard
        title="Required vs provisioned"
        description="The dispatcher's own scaling signal."
        actions={
          signal ? (
            <StatusBadgeV2
              tone={stale ? 'warn' : 'ok'}
              label={stale ? `Stale · ${formatDuration(snapshot.capacity.ageMs)} old` : 'Fresh'}
            />
          ) : undefined
        }
      >
        {!signal ? (
          <EmptyStateV2 variant="unavailable" title="No capacity signal reported">
            Application Auto Scaling has not published a signal yet.
          </EmptyStateV2>
        ) : (
          <KeyValueGrid
            columns={3}
            items={[
              { label: 'Required slots', value: signal.requiredSlots },
              { label: 'Provisioned tasks', value: signal.provisionedTasks },
              { label: 'Busy slots', value: signal.busySlots },
              { label: 'Ready idle slots', value: signal.readyIdleSlots },
              { label: 'Eligible jobs', value: signal.eligibleJobs },
              { label: 'Campaign demand', value: signal.campaignDemand },
              {
                label: 'Oldest eligible job',
                value: formatDuration(signal.oldestEligibleJobAgeSeconds * 1000),
              },
              { label: 'Limiting quota', value: signal.limitingQuota ?? null },
            ]}
          />
        )}
      </SectionCard>
    </div>
  );
}
