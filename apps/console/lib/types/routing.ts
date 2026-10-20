import type {
  RoutingAudio,
  RoutingIssue,
  RoutingPoint,
  RoutingPointDraft,
  RoutingPool,
  RoutingRelease,
} from '@winsendotai/ovo-contracts';

/**
 * Wire shapes of the routing console (Wave 15-17 routes, Wave 18 design sections 3 and 6). What the
 * contracts package already exports is re-exported; the Wave 18 shapes the designer, simulator and
 * pool screens read are written here until the contracts step lands them, so the screens develop
 * against the fixture API and swap these for contract imports without touching a component.
 */
export type {
  RoutingAudio,
  RoutingIssue,
  RoutingPoint,
  RoutingPointDraft,
  RoutingPool,
  RoutingRelease,
};

/** `GET /v1/routing/status`: the one route that answers while routing is off. */
export interface RoutingStatus {
  enabled: boolean;
  externalEnabled: boolean;
  transferEnabled: boolean;
  humanQueueEnabled: boolean;
  simulate?: { enabled: boolean; liveLlm: boolean; liveExternal: boolean };
  evalRuns?: boolean;
  outcomesAvailable?: boolean;
}

/** `?include=summary` on the points list. */
export interface PointSummary {
  nodes: number;
  pools: number;
  languages: number;
  humanQueues: number;
  latestRelease: { id: string; version: number; digest: string; draftVersion: number } | null;
  published: boolean;
  numbers: number;
}
export type PointRecord = RoutingPoint & { summary?: PointSummary; issues?: RoutingIssue[] };

/** A release as the history lists it (`?view=summary`): no snapshot. */
export interface ReleaseSummary {
  id: string;
  version: number;
  digest: string;
  draftVersion: number;
  createdAt: string;
  createdBy: string;
  counts?: { nodes: number; pools: number; members: number };
}

export type PoolRecord = RoutingPool & { usedBy?: string[] };
export type AudioRecord = RoutingAudio & { usedBy?: string[] };

export type RoutingChangeArea =
  | 'point'
  | 'language'
  | 'lines'
  | 'node'
  | 'branch'
  | 'engine'
  | 'fallback'
  | 'pool'
  | 'member'
  | 'transfer'
  | 'hold'
  | 'queue'
  | 'agent'
  | 'limits';
export interface RoutingChange {
  area: RoutingChangeArea;
  op: 'added' | 'removed' | 'changed';
  key: string;
  path: (string | number)[];
  summary: string;
  before?: unknown;
  after?: unknown;
}

export interface PublishPreview {
  issues: RoutingIssue[];
  blockers: RoutingIssue[];
  warnings: RoutingIssue[];
  canPublish: boolean;
  nextVersion: number;
  digest: string | null;
  previous: { id: string; version: number; digest: string; createdAt: string } | null;
  unchanged: boolean;
  changes: RoutingChange[];
  pins: {
    path: (string | number)[];
    agentId: string;
    was: 'latest' | 'pinned';
    releaseId: string;
  }[];
}

export interface PoolUtilisation {
  poolId: string;
  at: string;
  members: {
    memberId: string;
    active: number;
    capacity: number | null;
    enabled: boolean;
    open: boolean | null;
  }[];
  total: { active: number; capacity: number | null };
}

export const ROUTING_STATS_WINDOWS = ['24h', '7d', '30d'] as const;
export type StatsWindow = (typeof ROUTING_STATS_WINDOWS)[number];
export interface RoutingStats {
  available: boolean;
  window: StatsWindow;
  since: string;
  until: string;
  bucket: 'hour' | 'day';
  totals: {
    routed: number;
    undecided: number;
    byTarget: Record<'agent' | 'human' | 'end' | 'callback', number>;
    degraded: number;
    withFallback: number;
    withReask: number;
    transferred: number;
    reachedPerson: number;
    avgTurns: number | null;
    routeMsP50: number | null;
    routeMsP95: number | null;
  };
  series: {
    at: string;
    routed: number;
    agent: number;
    human: number;
    end: number;
    callback: number;
    fallback: number;
  }[];
  points: { pointId: string; routed: number; withFallback: number; human: number }[];
  pools: { poolId: string; picks: number; byMember: Record<string, number> }[];
}

/** An agent as the `/v1/agents` list returns it, reduced to what the pickers show. */
export interface AgentOption {
  id: string;
  name: string;
}

/** An inbound number as the Numbers tab reads it. */
export interface NumberRow {
  phoneNumber: string;
  version: number;
  enabled: boolean;
  releaseId: string | null;
  routingReleaseId: string | null;
  routing: { pointId: string; pointName: string; version: number } | null;
  carrierPluginId: string | null;
  carrierBindingId: string | null;
  variables: Record<string, string>;
}

/** Why a routing screen cannot show data: the feature is off, or the call failed. */
export type RoutingAvailability =
  | { kind: 'loading' }
  | { kind: 'ready'; status: RoutingStatus }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string };
