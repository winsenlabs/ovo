import { z } from 'zod';
import { RouteAgentId, RouteLines, RouteUuid, RoutingKey } from './ids.ts';
import {
  RoutingAgentTarget,
  RoutingPoolTarget,
  routingNodeTargets,
  type RoutingNode,
} from './tree.ts';

/**
 * Wave 16 (R2) in-call agent transfer: the routing point's transfer catalogue. Every target a
 * transfer can reach is resolved and pinned at publish, like an R1 tree target; an agent release
 * only opts in (`AgentConfig.handoff.agents`) and learns its allowed targets at call time.
 */
export const TRANSFER_LIMITS = Object.freeze({
  targets: 32,
  sources: 50,
  holdSteps: 12,
  timeoutSteps: 5,
  maxTransfersPerCall: 10,
  segmentsPerCall: 16,
  summaryChars: 1_000,
  reasonChars: 200,
  transcriptTurns: 20,
  transcriptChars: 6_000,
  holdSeconds: 900,
  clipSeconds: 300,
  uploadBytes: 10 * 1024 * 1024,
});
/** The completion-reason prefix of a segment that hands the call on (never `transfer:`, AGT-15). */
export const HANDOFF_REASON_PREFIX = 'handoff:';
export const DISCLOSURE_KINDS = ['identity', 'ai', 'recording', 'opt_out_hint'] as const;
export const DisclosureKind = z.enum(DISCLOSURE_KINDS);
export type DisclosureKind = z.infer<typeof DisclosureKind>;
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** One step of a hold sequence. */
export const HoldStep = z.discriminatedUnion('kind', [
  /** An uploaded clip (music or a custom recording); `sha256` is pinned at publish. */
  z
    .object({
      kind: z.literal('clip'),
      assetId: RouteUuid,
      sha256: Sha256.optional(),
      /** Cut the clip after this long; absent = play it whole. */
      maxSeconds: z.number().int().min(1).max(600).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('silence'), seconds: z.number().int().min(1).max(60) }).strict(),
  /** A reassurance line in the point's house voice (the router release's TTS). */
  z.object({ kind: z.literal('line'), line: RouteLines }).strict(),
]);
export type HoldStep = z.infer<typeof HoldStep>;

/** What happens when a hold reaches maxSeconds or its target cannot be started. */
export const HoldTimeoutStep = z.discriminatedUnion('kind', [
  /** Another catalogue target (its own gating except confirmation; never its own key). */
  z.object({ kind: z.literal('target'), key: RoutingKey }).strict(),
  /** The routing release's default target (direct, no claim). */
  z.object({ kind: z.literal('default') }).strict(),
  /** Back to the agent that transferred (a fresh graph of its release, told the transfer failed). */
  z.object({ kind: z.literal('return') }).strict(),
  /** R3: a queue bound in the point's `humanQueues`. Without bindings: a publish warning, skipped at run time. */
  z.object({ kind: z.literal('human'), queueId: RoutingKey }).strict(),
  z
    .object({
      kind: z.literal('callback'),
      inMinutes: z.number().int().min(5).max(10_080).default(120),
      line: RouteLines,
    })
    .strict(),
  z.object({ kind: z.literal('end'), line: RouteLines }).strict(),
]);
export type HoldTimeoutStep = z.infer<typeof HoldTimeoutStep>;
/** The steps a timeout chain must end in (`routing_transfer_timeout_not_terminal`). */
export const HOLD_TERMINAL_STEPS: readonly HoldTimeoutStep['kind'][] = [
  'default',
  'callback',
  'end',
];

export const HoldPolicy = z
  .object({
    /** Played in order from when the announcing segment ends until the target speaks; then from `loopFrom`. */
    steps: z.array(HoldStep).min(1).max(TRANSFER_LIMITS.holdSteps),
    loopFrom: z.number().int().min(0).max(11).default(0),
    /** Total hold (composition + capacity wait), from the announcing engine's end. */
    maxSeconds: z.number().int().min(5).max(TRANSFER_LIMITS.holdSeconds).default(120),
    /** Pool targets with every eligible member at capacity: hold and retry instead of refusing. */
    waitForCapacity: z.boolean().default(false),
    /** Must end in `default`, `callback` or `end` (structural check). */
    onTimeout: z.array(HoldTimeoutStep).min(1).max(TRANSFER_LIMITS.timeoutSteps),
  })
  .strict();
export type HoldPolicy = z.infer<typeof HoldPolicy>;

/** Where a transfer goes. Pool and agent reuse the R1 tree target shapes. */
export const TransferDestination = z.discriminatedUnion('kind', [
  RoutingPoolTarget,
  /** The pool the transferring member was claimed from, excluding that member. */
  z
    .object({
      kind: z.literal('same-pool'),
      language: z.enum(['caller', 'any']).default('caller'),
      skills: z.array(RoutingKey).max(10).default([]),
    })
    .strict(),
  RoutingAgentTarget,
  /** Re-route: the router (router release + router behaviour) resumes at this node. */
  z.object({ kind: z.literal('node'), node: RoutingKey }).strict(),
  /** R3: a human queue bound in the point's `humanQueues`. */
  z.object({ kind: z.literal('human'), queueId: RoutingKey }).strict(),
]);
export type TransferDestination = z.infer<typeof TransferDestination>;

/** Which segments may use a target. A segment matches by the pool/member it was claimed from, or by agent. */
export const TransferSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pool'), poolId: RouteUuid }).strict(),
  z.object({ kind: z.literal('member'), poolId: RouteUuid, memberId: RoutingKey }).strict(),
  z.object({ kind: z.literal('agent'), agentId: RouteAgentId }).strict(),
]);
export type TransferSource = z.infer<typeof TransferSource>;

export const TransferConfirm = z.enum(['never', 'ask']);
export type TransferConfirm = z.infer<typeof TransferConfirm>;

export const TransferTarget = z
  .object({
    key: RoutingKey,
    /** What the transferring agent's LLM reads to choose; never the destination. */
    description: z.string().trim().min(1).max(500),
    /** Spoken name ("our billing team") for the confirm question. Absent: the key, humanised. */
    label: RouteLines.optional(),
    destination: TransferDestination,
    /** Absent: every agent segment of this point may use it. */
    from: z.array(TransferSource).min(1).max(TRANSFER_LIMITS.sources).optional(),
    announcement: RouteLines.optional(),
    confirm: TransferConfirm.optional(),
    hold: HoldPolicy.optional(),
  })
  .strict();
export type TransferTarget = z.infer<typeof TransferTarget>;

export const RoutingTransferPolicy = z
  .object({
    targets: z.array(TransferTarget).max(TRANSFER_LIMITS.targets).default([]),
    /** Said by an agent before a transfer when neither the target nor the agent authors one. */
    announcement: RouteLines.optional(),
    /** Said instead when the transfer is queued for capacity ("All our agents are busy..."). */
    queueAnnouncement: RouteLines.optional(),
    confirm: TransferConfirm.default('never'),
    /** Every handoff of this point (the router's included) holds with this unless a target overrides it. */
    hold: HoldPolicy.optional(),
    limits: z
      .object({
        maxTransfers: z.number().int().min(1).max(TRANSFER_LIMITS.maxTransfersPerCall).default(3),
        /** A→B→A: `refuse` drops releases the call already left from candidates (and refuses if none remain). */
        returnToPrevious: z.enum(['refuse', 'allow']).default('refuse'),
        /** No transfer when less of the call's limit is left than this. */
        minRemainingSeconds: z.number().int().min(10).max(600).default(30),
      })
      .strict()
      .default({ maxTransfers: 3, returnToPrevious: 'refuse', minRemainingSeconds: 30 }),
    handover: z
      .object({
        summary: z.boolean().default(true),
        transcriptTurns: z.number().int().min(0).max(TRANSFER_LIMITS.transcriptTurns).default(6),
        capturedVariables: z.boolean().default(true),
      })
      .strict()
      .default({ summary: true, transcriptTurns: 6, capturedVariables: true }),
  })
  .strict();
export type RoutingTransferPolicy = z.infer<typeof RoutingTransferPolicy>;

/** Every hold policy of a transfer policy with its path (point-level first). */
export function transferHolds(
  policy: RoutingTransferPolicy | undefined,
): { path: (string | number)[]; hold: HoldPolicy; key?: string }[] {
  if (!policy) return [];
  const found: { path: (string | number)[]; hold: HoldPolicy; key?: string }[] = [];
  if (policy.hold) found.push({ path: ['transfer', 'hold'], hold: policy.hold });
  policy.targets.forEach((target, t) => {
    if (target.hold)
      found.push({ path: ['transfer', 'targets', t, 'hold'], hold: target.hold, key: target.key });
  });
  return found;
}

/** Pools a draft names: tree targets and transfer pool destinations, de-duplicated, in order. */
export function routingPoolIds(draft: {
  nodes: readonly RoutingNode[];
  transfer?: RoutingTransferPolicy;
}): string[] {
  const ids = new Set<string>();
  for (const { target } of routingNodeTargets(draft.nodes))
    if (target.kind === 'pool') ids.add(target.poolId);
  for (const target of draft.transfer?.targets ?? [])
    if (target.destination.kind === 'pool') ids.add(target.destination.poolId);
  return [...ids];
}

/** Audio assets a draft names: every hold `clip` step, de-duplicated, in order. */
export function routingAudioIds(draft: { transfer?: RoutingTransferPolicy }): string[] {
  const ids = new Set<string>();
  for (const { hold } of transferHolds(draft.transfer))
    for (const step of hold.steps) if (step.kind === 'clip') ids.add(step.assetId);
  return [...ids];
}
