import Link from 'next/link';
import { SectionCard } from '../components/ui/section-card';
import { StatusBadgeV2 } from '../components/ui/status-badge';
import { EmptyStateV2 } from '../components/ui/feedback-v2';
import { ProgressMeter } from '../components/charts/meter';
import { readinessIssueHref } from '../components/studio/release-panels';
import { humaniseEnum } from '../lib/status';
import { blockerSlot } from '../lib/derive/overview-text';
import type { AgentOverviewData } from '../lib/data/use-agent-overview';

/** The Overview tab's Readiness and Required-meters cards, split out of `agent-overview.tsx` to
 * stay under the module-size gate. */
export function ReadinessCard({
  agentId,
  readiness,
  readinessError,
}: {
  agentId: string;
  readiness: AgentOverviewData['readiness'];
  readinessError: AgentOverviewData['readinessError'];
}) {
  return (
    <SectionCard
      title="Readiness"
      actions={
        readiness ? (
          <StatusBadgeV2
            tone={readiness.releaseReady ? 'ok' : 'warn'}
            label={readiness.releaseReady ? 'Ready' : `${readiness.blockers.length} blockers`}
          />
        ) : (
          <StatusBadgeV2 tone="neutral" label="Unknown" />
        )
      }
    >
      {readinessError ? (
        <p className="ds-unknown">{readinessError}</p>
      ) : readiness?.blockers.length ? (
        <ul className="plain-list">
          {readiness.blockers.map((blocker) => {
            // Blockers are free-text server messages ("Carrier plugin X is not installed", "No
            // provider binding for slot stt"); when one names a slot, link straight to the
            // section that fixes it instead of leaving the operator to find it.
            const slot = blockerSlot(blocker);
            return (
              <li key={blocker}>
                {slot ? <Link href={readinessIssueHref(agentId, slot)}>{blocker}</Link> : blocker}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No outstanding blockers.</p>
      )}
      <Link className="button" href={`/agents/${encodeURIComponent(agentId)}/configure`}>
        Open Configure
      </Link>
    </SectionCard>
  );
}

export function RequiredMetersCard({
  agentId,
  meters,
  missingMeters,
  requiredMetersError,
}: {
  agentId: string;
  meters: AgentOverviewData['requiredMeters'];
  missingMeters: NonNullable<AgentOverviewData['requiredMeters']>['meters'];
  requiredMetersError: AgentOverviewData['requiredMetersError'];
}) {
  return (
    <SectionCard
      title="Required meters"
      description="Every billable unit this agent's plugins can emit, and whether a price card covers it."
      actions={
        meters ? (
          <StatusBadgeV2
            tone={meters.complete ? 'ok' : 'warn'}
            label={meters.complete ? 'Every meter priced' : `${missingMeters.length} unpriced`}
          />
        ) : undefined
      }
    >
      {requiredMetersError ? (
        <p className="ds-unknown">{requiredMetersError}</p>
      ) : meters?.meters ? (
        <>
          <ProgressMeter
            label="Meters priced"
            value={meters.meters.length - missingMeters.length}
            max={meters.meters.length || 1}
            valueLabel={`${meters.meters.length - missingMeters.length} of ${meters.meters.length}`}
            tone="ok"
          />
          {missingMeters.length > 0 && (
            <ul className="plain-list">
              {missingMeters.map((meter) => (
                <li key={meter.key}>
                  {meter.label} · <span className="ds-unknown">{humaniseEnum(meter.status)}</span>
                </li>
              ))}
            </ul>
          )}
          <Link
            className="button"
            href={`/agents/${encodeURIComponent(agentId)}/configure#group-cost`}
          >
            Open Cost
          </Link>
        </>
      ) : (
        <EmptyStateV2 variant="unavailable" title="Required meters are unavailable" />
      )}
    </SectionCard>
  );
}
