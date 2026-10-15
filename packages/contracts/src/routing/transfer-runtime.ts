import { z } from 'zod';
import { RoutingKey } from './ids.ts';
import { DisclosureKind, TRANSFER_LIMITS, type TransferConfirm } from './transfer.ts';

/** Where a re-routed router segment resumes (router behaviour config `entry`). */
export const RouterEntry = z
  .object({
    node: RoutingKey,
    path: z.array(RoutingKey).max(32),
    context: z
      .object({
        language: z
          .string()
          .regex(/^[a-z]{2,3}$/)
          .optional(),
        values: z.record(z.string(), z.string().max(80)),
      })
      .strict(),
    disclosed: z.array(DisclosureKind).max(4).default([]),
    /** The transfer this re-route belongs to; its final handoff counts under the same index. */
    transfer: z.number().int().min(1).max(TRANSFER_LIMITS.maxTransfersPerCall),
  })
  .strict();
export type RouterEntry = z.infer<typeof RouterEntry>;

/** What an incoming segment inherits (`ovo.agent-transfer` `inbound`). Free text is untrusted. */
export interface TransferHandover {
  kind: 'route' | 'transfer' | 'return';
  /** 1-based per call; absent for `route`. */
  transfer?: number;
  from?: { role: 'router' | 'agent'; agentId: string; releaseId: string };
  targetKey?: string;
  /** In the target's base language. */
  label?: string;
  /** At most 200 characters, written by the transferring LLM. */
  reason?: string;
  /** At most 1000 characters, written by the transferring LLM. */
  summary?: string;
  /** Oldest first, at most 6000 characters in total. */
  transcript: readonly { role: 'caller' | 'agent'; text: string }[];
  route?: { path: readonly string[]; language?: string; context: Readonly<Record<string, string>> };
  /** Captured values the target's variable schema declares and accepts (also merged into its variables). */
  captured: Readonly<Record<string, unknown>>;
  disclosed: readonly DisclosureKind[];
}

export interface TransferTargetOffer {
  key: string;
  /** Who answers: another agent (default) or, with R3 queues, a person. */
  kind?: 'agent' | 'human';
  description: string;
  /** In this agent's base language. */
  label?: string;
  confirm: TransferConfirm;
}

export const AGENT_TRANSFER_REFUSALS = [
  'transfer_disabled',
  'unknown_target',
  'not_granted',
  'limit_reached',
  'same_agent',
  'ping_pong',
  'pool_full',
  'no_eligible_member',
  'time_exhausted',
  'segments_exhausted',
  'not_confirmed',
  'busy',
  'call_ended',
  'release_missing',
  // R3: a human queue destination.
  'queue_unknown',
  'queue_closed',
  'queue_unavailable',
  'queue_full',
  'no_operators',
] as const;
export type AgentTransferRefusal = (typeof AGENT_TRANSFER_REFUSALS)[number];
export type AgentTransferResult =
  | { ok: true; transferId: string; announcement: string; queued: boolean }
  | { ok: false; reason: AgentTransferRefusal };

/**
 * Capability `ovo.agent-transfer` (session). Worker host → agent behaviour, on routed calls with
 * transfers on only; a direct call never has it, so `transfer_to_agent` is never offered there.
 */
export interface AgentTransferPort {
  readonly inbound?: TransferHandover;
  /** Targets this segment may use now (granted, not exhausted). Empty: offer no tool. */
  targets(): readonly TransferTargetOffer[];
  /**
   * Gates, resolves and begins the transfer; resolves fast (no composition wait). `confirmed` must
   * be true for a target whose confirm is `ask`; the behaviour sets it only when the caller's last
   * turn was a yes to the confirm question (classifyConfirmation), never on the LLM's word alone.
   */
  request(
    input: {
      key: string;
      source: 'llm' | 'flow';
      reason?: string;
      summary?: string;
      confirmed: boolean;
    },
    signal: AbortSignal,
  ): Promise<AgentTransferResult>;
  /** The announcement is about to play: from now on the segment ends into the transfer. */
  commit(transferId: string): void;
  /** Before commit only; idempotent. */
  cancel(transferId: string): Promise<void>;
}
