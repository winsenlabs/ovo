// Pure aggregation for the Infrastructure screen: worker capacity segments and the in-session
// history ring buffer the brief asks for ("keep the last 20 snapshots while the page is open").
import type { MeterSegment } from '../../components/charts/meter';
import type { InfrastructureSnapshot } from '../operator-api';

/** Busy/reserved/ready/starting/draining as meter segments against the capacity ceiling. Zero or
 * unknown segments are left out rather than drawn as a visible zero-width slice. */
export function capacitySegments(workers: InfrastructureSnapshot['workers']): {
  segments: MeterSegment[];
  max: number;
} {
  const segment = (label: string, value: number | null, tone: MeterSegment['tone']) =>
    value != null && value > 0 ? [{ label, value, tone }] : [];
  return {
    segments: [
      ...segment('Busy', workers.busy, 'info'),
      ...segment('Reserved', workers.reserved, 'warn'),
      ...segment('Ready idle', workers.ready, 'ok'),
      ...segment('Starting', workers.starting, 'neutral'),
      ...segment('Draining', workers.draining, 'neutral'),
    ],
    max: workers.capacityCeiling ?? Math.max(1, workers.total ?? 1),
  };
}

export type HistoryPoint = {
  at: number;
  busy: number;
  queueDepth: number;
  eventsPerFiveMin: number;
};

export const HISTORY_LIMIT = 20;

/** Appends one sample and trims to the last `HISTORY_LIMIT`. Missing metrics record as 0 so the
 * sparkline keeps a point rather than a gap — these are "since you opened this page" shapes, not
 * ledger values. */
export function pushHistory(
  history: readonly HistoryPoint[],
  snapshot: InfrastructureSnapshot,
): HistoryPoint[] {
  const point: HistoryPoint = {
    at: Date.now(),
    busy: snapshot.workers.busy ?? 0,
    queueDepth: snapshot.queue.depth ?? 0,
    eventsPerFiveMin: snapshot.telemetry?.eventsLastFiveMinutes ?? 0,
  };
  return [...history, point].slice(-HISTORY_LIMIT);
}

export function isStale(ageMs: number | null, maxAgeMs: number): boolean {
  return ageMs != null && ageMs > maxAgeMs;
}

export function quotaRatio(remaining: number | null, limit: number | null): number | null {
  if (remaining == null || limit == null || limit <= 0) return null;
  return remaining / limit;
}
