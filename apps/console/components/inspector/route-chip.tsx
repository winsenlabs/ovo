'use client';
import Link from 'next/link';
import { humaniseEnum } from '../../lib/status';
import { TARGET_LABELS } from '../../lib/derive/call-route-summary';
import type { CallRouteInfo } from '../../lib/types/call-route';

/** "Routed to Agent · 3 segments" for the call header; links to the routing point that routed it. */
export function RouteChip({ route, segments }: { route: CallRouteInfo; segments: number }) {
  const label = `Routed to ${TARGET_LABELS[route.target] ?? humaniseEnum(route.target)}${
    segments > 1 ? ` · ${segments} segments` : ''
  }`;
  return (
    <Link
      className="ds-chip"
      href={`/routing/points/${encodeURIComponent(route.routingPointId)}`}
      title={`Routing point ${route.routingPointId}`}
    >
      {label}
    </Link>
  );
}
