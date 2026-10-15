import { z } from 'zod';
import type { RouteSegmentPayload } from './events.ts';
import { DisclosureKind } from './transfer.ts';

/**
 * Payloads of the R2 session events `transfer.requested`, `transfer.completed`, `segment.ended`
 * and `disclosure`. Loose like every session event, and like the `route.*` events they carry keys,
 * codes, ids and timings only: never caller words, phone numbers or the transferring LLM's text.
 */
const Name = z.string().trim().min(1).max(200);
const Code = z.string().max(80);
const Index = z.number().int().nonnegative();
const Ms = z.number().nonnegative();

export const TRANSFER_SOURCES = ['router', 'llm', 'flow', 'fallback'] as const;
export const TransferRequestedPayload = z.looseObject({
  /** 1-based per call. */
  transfer: z.number().int().min(1),
  fromSegment: Index,
  source: z.enum(TRANSFER_SOURCES),
  kind: z.enum(['agent', 'queue', 'node', 'human']),
  key: Name.optional(),
  confirm: z.enum(['never', 'asked']).optional(),
  result: z.enum(['accepted', 'refused']),
  /** An `AgentTransferRefusal` or `HandoffBeginFailure` code. */
  refusal: Code.optional(),
  queued: z.boolean().optional(),
});
export type TransferRequestedPayload = z.infer<typeof TransferRequestedPayload>;

export const TRANSFER_OUTCOMES = [
  'connected',
  'fallback',
  'returned',
  'callback',
  'ended',
  'caller_hangup',
  'failed',
] as const;
export const TransferCompletedPayload = z.looseObject({
  transfer: z.number().int().min(1),
  outcome: z.enum(TRANSFER_OUTCOMES),
  toSegment: Index.optional(),
  agentId: Name.optional(),
  releaseId: Name.optional(),
  poolId: Name.optional(),
  memberId: Name.optional(),
  holdMs: Ms,
  prepareMs: Ms.optional(),
  queueMs: Ms.optional(),
  gapMs: Ms.optional(),
  /** Which hold played: the target's, the point's, or `DEFAULT_HOLD_POLICY`. */
  holdPolicy: z.enum(['target', 'point', 'default', 'queue']).optional(),
  /** The timeout chain steps that ran, in order. */
  steps: z
    .array(
      z
        .object({
          step: z.enum([
            'target',
            'default',
            'return',
            'human',
            'callback',
            'end',
            'release_default',
          ]),
          result: z.enum(['taken', 'skipped', 'failed']),
          reason: Code.optional(),
        })
        .strict(),
    )
    .max(8)
    .default([]),
  /** compose_failed, timeout, start_failed, hold_timeout, cancelled... */
  reason: Code.optional(),
});
export type TransferCompletedPayload = z.infer<typeof TransferCompletedPayload>;

/** `carrier_transfer`: the leg left OVO for a third party. `operator_end`: the operator ended the call. */
export const SEGMENT_ENDINGS = [
  'handoff',
  'call_end',
  'start_failed',
  'carrier_transfer',
  'operator_end',
] as const;
export const SegmentEndedPayload = z.looseObject({
  index: Index,
  role: z.enum(['router', 'agent', 'human']),
  agentId: Name,
  releaseId: Name,
  language: z.string().max(12).optional(),
  ended: z.enum(SEGMENT_ENDINGS),
  endReason: z.string().max(200),
  durationMs: Ms,
  turns: Index,
  /** Provider usage this segment reported, by meter key (quantities, not money). */
  usage: z
    .record(z.string().max(120), z.number().nonnegative())
    .refine((usage) => Object.keys(usage).length <= 24, 'At most 24 meters')
    .optional(),
});
export type SegmentEndedPayload = z.infer<typeof SegmentEndedPayload>;

/** Disclosure kinds the caller heard in full; later segments of the call skip them. */
export const DisclosurePayload = z.looseObject({
  kinds: z.array(DisclosureKind).min(1).max(4),
  /** Stamped by the worker sink. */
  segment: Index.optional(),
});
export type DisclosurePayload = z.infer<typeof DisclosurePayload>;

/** `CallOutcomeSummary.segments[]`: one per `route.segment`, closed by its `segment.ended`. */
export interface CallOutcomeSegment {
  index: number;
  role: 'router' | 'agent' | 'human';
  agentId: string;
  releaseId: string;
  reason: RouteSegmentPayload['reason'];
  poolId: string | null;
  memberId: string | null;
  language: string | null;
  transfer: number | null;
  /** Event time. */
  startedAt: string;
  /** From `segment.ended`. */
  durationMs: number | null;
  ended: (typeof SEGMENT_ENDINGS)[number] | null;
}

/** `CallOutcomeSummary.transfers`: counts folded from `transfer.requested` and `transfer.completed`. */
export interface CallOutcomeTransfers {
  requested: number;
  refused: number;
  connected: number;
  /** Completed with any outcome but `connected` or `caller_hangup`. */
  failed: number;
}
