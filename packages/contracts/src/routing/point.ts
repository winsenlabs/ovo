import { z } from 'zod';
import { HumanQueueBinding, QueueSnapshot } from '../human-queue/queue.ts';
import {
  RouteAgentId,
  RouteAgentRef,
  RouteLanguage,
  RouteLines,
  RouteUuid,
  RoutingKey,
} from './ids.ts';
import { PoolMember } from './pool.ts';
import { RoutingNode, routingNodeTargets, type RoutingPath } from './tree.ts';
import { routingDraftIssues } from './issues.ts';
import { RoutingTransferPolicy, transferHolds } from './transfer.ts';

export const RoutingPointDraft = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2_000).optional(),
    /** The router's voice: any agent-mode release with an STT selection. */
    router: RouteAgentRef,
    /** Always-available direct agent: last resort, kill-switch target, `default` step default. */
    defaultTarget: RouteAgentRef,
    language: z
      .object({ default: RouteLanguage, allowed: z.array(RouteLanguage).min(1).max(12) })
      .strict(),
    greeting: RouteLines,
    /** Said before the handoff. Absent: built-in en/hi "Connecting you now." lines. */
    connecting: RouteLines.optional(),
    root: RoutingKey,
    nodes: z.array(RoutingNode).min(1).max(100),
    limits: z
      .object({
        maxTurns: z.number().int().min(1).max(20).default(6),
        maxRouteSeconds: z.number().int().min(10).max(300).default(90),
      })
      .strict()
      .default({ maxTurns: 6, maxRouteSeconds: 90 }),
    idle: z
      .object({
        timeoutMs: z.number().int().min(3_000).max(30_000).default(8_000),
        prompts: z.array(RouteLines).max(2).default([]),
      })
      .strict()
      .optional(),
    /** R2: the transfer catalogue, hold and limits every handoff of this point uses. */
    transfer: RoutingTransferPolicy.optional(),
    /** R3: the human queues this point may use, by the key its `human` steps and targets name. */
    humanQueues: z.array(HumanQueueBinding).max(10).optional(),
  })
  .strict();
export type RoutingPointDraft = z.infer<typeof RoutingPointDraft>;

export interface RoutingPoint {
  id: string;
  workspaceId: string;
  draft: RoutingPointDraft;
  draftVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** `RouteAgentRef` whose release is `pinned`. */
export const PinnedAgentRef = z
  .object({
    agentId: RouteAgentId,
    release: z.object({ kind: z.literal('pinned'), releaseId: RouteUuid }).strict(),
  })
  .strict();
export type PinnedAgentRef = z.infer<typeof PinnedAgentRef>;

/** A pool as frozen into a release: every member pinned. */
export const PoolSnapshot = z
  .object({
    id: RouteUuid,
    version: z.number().int().positive(),
    name: z.string(),
    languageFallback: z.array(RouteLanguage).max(5),
    members: z
      .array(PoolMember.extend({ agent: PinnedAgentRef }))
      .min(1)
      .max(100),
  })
  .strict();
export type PoolSnapshot = z.infer<typeof PoolSnapshot>;

/** Workspace queue ids a draft binds, de-duplicated, in order (R3). */
export function routingQueueIds(draft: Pick<RoutingPointDraft, 'humanQueues'>): string[] {
  return [...new Set((draft.humanQueues ?? []).map((binding) => binding.queueId))];
}

/**
 * Every agent reference in a draft with its path: router, default target, every tree target and
 * every transfer `agent` destination.
 */
export function routingAgentRefs(
  draft: Pick<RoutingPointDraft, 'router' | 'defaultTarget' | 'nodes' | 'transfer'>,
): { path: RoutingPath; ref: RouteAgentRef }[] {
  const refs: { path: RoutingPath; ref: RouteAgentRef }[] = [
    { path: ['router'], ref: draft.router },
    { path: ['defaultTarget'], ref: draft.defaultTarget },
  ];
  for (const { path, target } of routingNodeTargets(draft.nodes)) {
    if (target.kind === 'agent') refs.push({ path: [...path, 'agent'], ref: target.agent });
    if (target.kind === 'callback' && target.agent)
      refs.push({ path: [...path, 'agent'], ref: target.agent });
  }
  draft.transfer?.targets.forEach((target, t) => {
    if (target.destination.kind === 'agent')
      refs.push({
        path: ['transfer', 'targets', t, 'destination', 'agent'],
        ref: target.destination.agent,
      });
  });
  return refs;
}

export const RoutingReleaseSnapshot = RoutingPointDraft.extend({
  /** 3 when the draft binds human queues (R3), else 2 when it has a `transfer` policy (R2), else 1. */
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  routingPointId: RouteUuid,
  router: PinnedAgentRef,
  defaultTarget: PinnedAgentRef,
  /** Every pool any target names, keyed by its id. */
  pools: z.record(RouteUuid, PoolSnapshot),
  /** R3: every bound queue, pinned by value and keyed by its id. */
  queues: z.record(RouteUuid, QueueSnapshot).default({}),
  /** Router, default, every member and every direct/callback agent release, de-duplicated. */
  releaseIds: z.array(RouteUuid).min(2).max(500),
})
  .strict()
  .superRefine((snapshot, ctx) => {
    const issue = (path: RoutingPath, message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const needed = new Set<string>();
    for (const { path, ref } of routingAgentRefs(snapshot)) {
      if (ref.release.kind === 'pinned') needed.add(ref.release.releaseId);
      else issue([...path, 'release'], 'A release snapshot pins every agent reference');
    }
    for (const { path, target } of routingNodeTargets(snapshot.nodes))
      if (target.kind === 'pool' && !Object.hasOwn(snapshot.pools, target.poolId))
        issue([...path, 'poolId'], 'The snapshot holds every pool a target names');
    if (snapshot.humanQueues?.length) {
      if (snapshot.schemaVersion !== 3)
        issue(['schemaVersion'], 'A snapshot that binds human queues is schemaVersion 3');
    } else if (snapshot.schemaVersion === 3)
      issue(['schemaVersion'], 'schemaVersion 3 is for snapshots that bind human queues');
    else if ((snapshot.schemaVersion === 2) !== (snapshot.transfer !== undefined))
      issue(
        ['schemaVersion'],
        'A snapshot is schemaVersion 2 exactly when it has a transfer policy',
      );
    const bound = new Map((snapshot.humanQueues ?? []).map((b) => [b.queueId, b]));
    for (const [id, queue] of Object.entries(snapshot.queues)) {
      const binding = bound.get(id);
      if (queue.id !== id) issue(['queues', id, 'id'], 'A queue snapshot is keyed by its id');
      else if (!binding) issue(['queues', id], 'The snapshot holds only queues the draft binds');
      else if (binding.key !== queue.key || binding.priority !== queue.priority)
        issue(['queues', id], 'A queue snapshot carries its binding key and priority');
    }
    for (const queueId of bound.keys())
      if (!Object.hasOwn(snapshot.queues, queueId))
        issue(['queues', queueId], 'The snapshot holds every queue the draft binds');
    snapshot.transfer?.targets.forEach((target, t) => {
      const { destination } = target;
      if (destination.kind === 'pool' && !Object.hasOwn(snapshot.pools, destination.poolId))
        issue(
          ['transfer', 'targets', t, 'destination', 'poolId'],
          'The snapshot holds every pool a transfer names',
        );
    });
    for (const { path, hold } of transferHolds(snapshot.transfer))
      hold.steps.forEach((step, s) => {
        if (step.kind === 'clip' && !step.sha256)
          issue([...path, 'steps', s, 'sha256'], 'A release snapshot pins every hold clip digest');
      });
    for (const [id, pool] of Object.entries(snapshot.pools)) {
      if (pool.id !== id) issue(['pools', id, 'id'], 'A pool snapshot is keyed by its id');
      for (const member of pool.members) needed.add(member.agent.release.releaseId);
    }
    const listed = new Set(snapshot.releaseIds);
    if (listed.size !== snapshot.releaseIds.length)
      issue(['releaseIds'], 'Release ids are de-duplicated');
    for (const id of needed)
      if (!listed.has(id)) issue(['releaseIds'], `Release ${id} is referenced but not listed`);
    for (const found of routingDraftIssues(snapshot))
      if (found.severity === 'error') issue(found.path, `${found.code}: ${found.message}`);
  });
export type RoutingReleaseSnapshot = z.infer<typeof RoutingReleaseSnapshot>;

export interface RoutingRelease {
  id: string;
  workspaceId: string;
  routingPointId: string;
  /** 1, 2, 3... per point. */
  version: number;
  /** The point draft it froze. */
  draftVersion: number;
  snapshot: RoutingReleaseSnapshot;
  /** sha256 of canonicalJson(snapshot), hex. */
  digest: string;
  createdAt: string;
  createdBy: string;
}
