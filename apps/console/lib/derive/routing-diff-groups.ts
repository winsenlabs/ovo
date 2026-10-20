import type { RoutingChange, RoutingChangeArea } from '@winsendotai/ovo-contracts';

/** Changes grouped by area, in a stable reading order, for the publish drawer and release diff. */
export const AREA_ORDER: RoutingChangeArea[] = [
  'point',
  'agent',
  'language',
  'lines',
  'limits',
  'node',
  'branch',
  'engine',
  'fallback',
  'transfer',
  'hold',
  'queue',
  'pool',
  'member',
];
export const AREA_LABEL: Record<RoutingChangeArea, string> = {
  point: 'Point',
  agent: 'Agents',
  language: 'Languages',
  lines: 'Spoken lines',
  limits: 'Limits',
  node: 'Questions',
  branch: 'Branches',
  engine: 'Engines',
  fallback: 'Fallbacks',
  transfer: 'Transfers',
  hold: 'Hold',
  queue: 'Human queues',
  pool: 'Pools',
  member: 'Pool members',
};
export function groupChanges(changes: readonly RoutingChange[]) {
  return AREA_ORDER.map((area) => ({
    area,
    label: AREA_LABEL[area],
    items: changes.filter((c) => c.area === area),
  })).filter((g) => g.items.length);
}
