import { z } from 'zod';
import { RouteLanguage, RouteUuid } from './ids.ts';

const Count = z.number().int().nonnegative();
const Digest = z.string().regex(/^[0-9a-f]{64}$/);

/** `GET /v1/routing/status`: what is on, and what the console may offer. Answers while routing is dark. */
export const RoutingStatus = z.object({
  /** Routing is on and the operations database is there. */
  enabled: z.boolean(),
  externalEnabled: z.boolean(),
  transferEnabled: z.boolean(),
  humanQueueEnabled: z.boolean(),
  /** The route tester: on with routing; the live toggles say whether a real engine may be called. */
  simulate: z.object({ enabled: z.boolean(), liveLlm: z.boolean(), liveExternal: z.boolean() }),
  /** Server-run eval corpora (`/v1/routing/eval-runs`). */
  evalRuns: z.boolean(),
  /** Call outcomes are stored here, so stats and the calls routing filters can answer. */
  outcomesAvailable: z.boolean(),
});
export type RoutingStatus = z.infer<typeof RoutingStatus>;

/** The newest release of a point, without its snapshot. */
export const RoutingReleaseStub = z.object({
  id: RouteUuid,
  version: z.number().int().positive(),
  digest: Digest,
  draftVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export type RoutingReleaseStub = z.infer<typeof RoutingReleaseStub>;

/** `GET /v1/routing/points?include=summary`: each point's `summary`. */
export const RoutingPointSummary = z.object({
  nodes: Count,
  pools: Count,
  /** The languages the point allows. */
  languages: z.array(RouteLanguage),
  humanQueues: Count,
  latestRelease: RoutingReleaseStub.nullable(),
  /** The latest release froze the current draft (no unpublished changes). */
  published: z.boolean(),
  /** Inbound numbers pinned to any release of the point. */
  numbers: Count,
});
export type RoutingPointSummary = z.infer<typeof RoutingPointSummary>;

/** `GET /v1/routing/points/:id/releases?view=summary`: a release without its snapshot. */
export const RoutingReleaseSummary = RoutingReleaseStub.extend({
  routingPointId: RouteUuid,
  createdBy: z.string().max(200),
  counts: z.object({
    nodes: Count,
    pools: Count,
    members: Count,
    agents: Count,
    humanQueues: Count,
  }),
  /** Inbound numbers pinned to this release. */
  numbers: Count,
});
export type RoutingReleaseSummary = z.infer<typeof RoutingReleaseSummary>;
