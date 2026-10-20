import { z } from 'zod';
import type { RoutingPointDraft, RoutingReleaseSnapshot } from './point.ts';

export const ROUTING_CHANGE_AREAS = [
  'point',
  'language',
  'lines',
  'node',
  'branch',
  'engine',
  'fallback',
  'pool',
  'member',
  'transfer',
  'hold',
  'queue',
  'agent',
  'limits',
] as const;
export type RoutingChangeArea = (typeof ROUTING_CHANGE_AREAS)[number];

/** One difference between two drafts or snapshots, in a deterministic English sentence. */
export const RoutingChange = z.object({
  area: z.enum(ROUTING_CHANGE_AREAS),
  op: z.enum(['added', 'removed', 'changed']),
  /** What changed, readable: "node intent", "pool Sales / member sales-hi". */
  key: z.string().max(400),
  path: z.array(z.union([z.string(), z.number()])),
  summary: z.string().max(1_000),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type RoutingChange = z.infer<typeof RoutingChange>;

/** A draft, or a release snapshot (a superset of a draft: pinned agents, pools, queues). */
export type RoutingDiffInput = RoutingPointDraft | RoutingReleaseSnapshot;
