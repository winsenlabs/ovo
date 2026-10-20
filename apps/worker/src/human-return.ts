import {
  TRANSFER_BUILT_IN_LINES,
  type RouteLines,
  type RoutingTransferPolicy,
  type TransferTarget,
} from '@winsendotai/ovo-contracts';
import type { SegmentHistoryEntry } from './call-memory.ts';
import type { HumanRuntimeDeps } from './human-runtime.ts';
import type { HoldPlayer } from './hold-player.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import type { TransferController } from './transfer-controller.ts';
import type { ResolvedTarget } from './transfer-types.ts';

type Return = NonNullable<HumanRuntimeDeps['returnToAgent']>;

/**
 * The operator sends the caller back to an agent (human queue design 7.5 `return_to_agent`): the
 * catalogue key resolves through the ordinary transfer path (its gating is the queue's
 * `returnTargets`, which the bridge checked), the target composes in the background, the point's
 * announcement is said in the house voice (no engine remains to say it), and then the human
 * segment ends into the committed handoff exactly as an agent's does. A refusal leaves the
 * operator on the call.
 */
export function createReturnToAgent(input: {
  controller: Pick<TransferController, 'beginWith' | 'commit' | 'abandon' | 'ended'>;
  policy?: RoutingTransferPolicy;
  /** Resolves the key as a transfer from the human segment, without the source grant. */
  resolve(
    target: TransferTarget,
    from: SegmentHistoryEntry,
  ): Promise<ResolvedTarget | { refusal: string }>;
  /** A hold player on its own lease, for the one announcement line. */
  holdPlayer(tags: Record<string, unknown>): HoldPlayer;
  /** The caller returns to an agent: member claims taken for the target are let go on a refusal. */
  releaseClaim(): Promise<void>;
}): Return {
  return async ({ key, from, lease, signal }) => {
    const { controller, policy } = input;
    const target = policy?.targets.find((item) => item.key === key);
    if (!target) return { ok: false, reason: 'unknown_target' };
    const resolved = await input.resolve(target, from);
    if ('refusal' in resolved) return { ok: false, reason: resolved.refusal };
    const begun = await controller.beginWith(resolved.request, signal, {
      target,
      claimed: resolved.claimed,
    });
    if (!begun.ok) {
      if (resolved.claimed) await input.releaseClaim();
      return { ok: false, reason: begun.reason };
    }
    await announce(input, target, begun.handoffId);
    if (controller.ended || signal.aborted) {
      await controller.abandon(begun.handoffId);
      return { ok: false, reason: 'call_ended' };
    }
    controller.commit(begun.handoffId);
    await endIntoHandoff(lease);
    return { ok: true };
  };
}

/** The target's line, else the point's, else the built-in one, in the call's language. */
async function announce(
  input: Parameters<typeof createReturnToAgent>[0],
  target: TransferTarget,
  handoffId: string,
): Promise<void> {
  const lines: RouteLines =
    target.announcement ?? input.policy?.announcement ?? TRANSFER_BUILT_IN_LINES.announcement;
  const hold = input.holdPlayer({ handoffId, why: 'return_to_agent' });
  await hold.say(lines, 'return_to_agent');
}

/** Ends the human segment into the committed handoff: the lease's close is intercepted. */
async function endIntoHandoff(lease: SegmentMediaLease): Promise<void> {
  await lease.close('behavior_completed');
}
