'use client';
import type { ReadonlyURLSearchParams } from 'next/navigation';
import { Select } from '../../../components/ui/inputs';
import { Switch } from '../../../components/ui/display';
import type { RoutingPointOption, RoutingStatusLite } from '../../../lib/types/call-route';

/** The URL keys of the routing filters; a boolean one is `1` when on. */
export const ROUTING_FILTERS = [
  'routingPointId',
  'segmentAgentId',
  'transferred',
  'human',
  'fallback',
] as const;

export const ROUTING_FILTER_LABELS: Record<string, string> = {
  routingPointId: 'Routing point',
  segmentAgentId: 'Agent segment',
  transferred: 'Transferred',
  human: 'Reached a person',
  fallback: 'Used a fallback',
};

export type RoutingFilterAvailability =
  /** Routing is on and outcomes are stored: the filters work. */
  | { state: 'ready' }
  /** Nothing to show yet (the status has not answered). */
  | { state: 'loading' }
  /** Routing is off, or outcomes are not stored: `reason` says which. */
  | { state: 'unavailable'; reason: string };

const BOOLEAN_FILTERS = ['transferred', 'human', 'fallback'] as const;

/** True when a routing filter is in the URL (so a dead one is still explained, never silent). */
export function hasRoutingFilter(search: ReadonlyURLSearchParams): boolean {
  return ROUTING_FILTERS.some((key) => search.get(key));
}

/**
 * Routing point, agent segment and the three yes/no routing facts. Hidden while routing is dark
 * and no routing filter is set; disabled with the reason when one is set but cannot be applied.
 */
export function RoutingFilters({
  search,
  setFilter,
  availability,
  points,
  agents,
}: {
  search: ReadonlyURLSearchParams;
  setFilter: (key: string, value: string) => void;
  availability: RoutingFilterAvailability;
  points: readonly RoutingPointOption[];
  agents: Map<string, string>;
}) {
  const unavailable = availability.state === 'unavailable';
  if (availability.state === 'loading' || (unavailable && !hasRoutingFilter(search))) return null;
  return (
    <fieldset
      className="route-filters"
      disabled={unavailable}
      aria-describedby={unavailable ? 'route-filters-reason' : undefined}
    >
      <legend className="sr-only">Routing filters</legend>
      <Select
        aria-label="Routing point"
        value={search.get('routingPointId') ?? ''}
        onChange={(value) => setFilter('routingPointId', value)}
        placeholder="All routing points"
        options={points.map((point) => ({ value: point.id, label: point.name }))}
      />
      <Select
        aria-label="Agent segment"
        value={search.get('segmentAgentId') ?? ''}
        onChange={(value) => setFilter('segmentAgentId', value)}
        placeholder="Any agent segment"
        options={[...agents.entries()].map(([id, name]) => ({ value: id, label: name }))}
      />
      {BOOLEAN_FILTERS.map((key) => (
        <Switch
          key={key}
          label={ROUTING_FILTER_LABELS[key]!}
          checked={search.get(key) === '1'}
          onChange={(on) => setFilter(key, on ? '1' : '')}
        />
      ))}
      {unavailable && (
        <p id="route-filters-reason" className="muted route-filters-reason" role="status">
          Routing filters are not applied. {availability.reason}
        </p>
      )}
    </fieldset>
  );
}

/** Whether the routing filters work: routing on, and the API able to read call outcomes. */
export function routingAvailability(
  status: RoutingStatusLite | null | 'pending',
  outcomesAbsent: boolean,
): RoutingFilterAvailability {
  if (status === 'pending') return { state: 'loading' };
  if (!status?.enabled) return { state: 'unavailable', reason: 'Routing is not enabled here.' };
  if (outcomesAbsent || status.outcomesAvailable === false)
    return {
      state: 'unavailable',
      reason: 'This installation does not store call outcomes (PostgreSQL only).',
    };
  return { state: 'ready' };
}
