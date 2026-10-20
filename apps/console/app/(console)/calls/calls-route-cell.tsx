import Link from 'next/link';
import type { CallOutcomeSummary } from '@winsendotai/ovo-contracts';
import { callRouteSummary } from '../../../lib/derive/calls';
import { TARGET_LABELS } from '../../../lib/derive/call-route-summary';
import { humaniseEnum } from '../../../lib/status';

/**
 * The Calls list's Route column: the routing point, where the call was sent, and the facts a
 * reader scans for (several segments, a transfer, a person, a fallback). A direct call says so.
 */
export function RouteCell({
  outcome,
  points,
  agentsByRelease,
}: {
  outcome: CallOutcomeSummary | null | undefined;
  points: ReadonlyMap<string, string>;
  agentsByRelease: ReadonlyMap<string, string>;
}) {
  if (!outcome) return <span className="ds-unknown">—</span>;
  const route = callRouteSummary(outcome);
  if (!route) return <span className="muted">Direct</span>;
  const destination =
    route.target === 'agent' && route.agentReleaseId
      ? (agentsByRelease.get(route.agentReleaseId) ?? TARGET_LABELS.agent)
      : (TARGET_LABELS[route.target] ?? humaniseEnum(route.target));
  const facts = [
    route.segments > 1 && `${route.segments} segments`,
    route.transferred && 'Transferred',
    route.person && 'Person',
    route.usedFallback && 'Fallback',
  ].filter(Boolean) as string[];
  return (
    <span className="route-cell">
      <Link href={`/routing/points/${encodeURIComponent(route.pointId)}`}>
        {points.get(route.pointId) ?? 'Routing point'}
      </Link>
      <span className="muted">
        <span aria-hidden="true">→ </span>
        <span className="sr-only">sent to </span>
        {destination}
      </span>
      {facts.length > 0 && (
        <span className="ui-cluster">
          {facts.map((fact) => (
            <span key={fact} className="ds-chip">
              {fact}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
