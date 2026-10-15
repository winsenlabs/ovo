import type {
  FallbackStep,
  RouteFallbackPayload,
  RoutingNode,
  RoutingTarget,
} from '@winsendotai/ovo-contracts';
import type { RouteRecorder } from './events.ts';
import type { FallbackCursor } from './state.ts';
import type { Attempt, Resolution } from './targets.ts';

export type FallbackResult =
  { kind: 'reask'; line: string } | { kind: 'resolved'; resolution: Resolution };

export interface FallbackInput {
  node: RoutingNode;
  cursor: FallbackCursor;
  turn: number;
  recorder: RouteRecorder;
  /**
   * Re-asks are skipped (recorded with this reason) when the caller was understood and the target
   * failed: asking again cannot fill a full pool. Absent: re-asks run.
   */
  noReask?: string;
  /** The re-ask line for a step: the generated question, the step's line, the node's ask. */
  reaskLine: (step: Extract<FallbackStep, { kind: 'reask' }>) => string | undefined;
  /** The release's direct default agent, the target of a `default` step without one. */
  defaultTarget: RoutingTarget;
  /** Said when even the release default cannot be prepared. */
  finalLine: string;
  attempt: (target: RoutingTarget) => Promise<Attempt>;
}

function event(
  input: Pick<FallbackInput, 'turn' | 'node' | 'recorder'>,
  step: RouteFallbackPayload['step'],
  result: RouteFallbackPayload['result'],
  attempt: number,
  reason?: string,
): void {
  input.recorder.fallback({
    turn: input.turn,
    node: input.node.id,
    step,
    result,
    attempt,
    ...(reason ? { reason } : {}),
  });
}

function asTarget(
  step: Exclude<FallbackStep, { kind: 'reask' }>,
  input: FallbackInput,
): RoutingTarget {
  if (step.kind === 'default') return step.target ?? input.defaultTarget;
  return step as RoutingTarget;
}

/**
 * The node's fallback chain (§7.5 step 5), resumed where it last stopped: a `reask` is spoken up to
 * `times` (one per turn), a `default` (its target or the release default) and a terminal
 * `callback`/`end` resolve, a `human` queue is skipped in R1, and a step that fails moves on. Every
 * step taken, skipped or failed is a `route.fallback` event. An exhausted chain falls to the
 * release default (`release_default`), and if even that cannot be prepared, to the built-in end
 * line, so the caller is never left in silence.
 */
export async function runFallback(input: FallbackInput): Promise<FallbackResult> {
  const { node, cursor } = input;
  while (cursor.index < node.fallback.length) {
    const step = node.fallback[cursor.index]!;
    if (step.kind === 'reask') {
      if (input.noReask !== undefined) {
        event(input, 'reask', 'skipped', cursor.reasks + 1, input.noReask);
      } else if (cursor.reasks < step.times) {
        const line = input.reaskLine(step);
        if (line) {
          cursor.reasks += 1;
          event(input, 'reask', 'taken', cursor.reasks);
          return { kind: 'reask', line };
        }
        event(input, 'reask', 'skipped', cursor.reasks + 1, 'no_line');
      }
      cursor.index += 1;
      cursor.reasks = 0;
      continue;
    }
    cursor.index += 1;
    const result = await input.attempt(asTarget(step, input));
    if (result.ok) {
      event(input, step.kind, 'taken', 1);
      return { kind: 'resolved', resolution: result.resolution };
    }
    const skipped = result.reason === 'human_queue_unavailable';
    event(input, step.kind, skipped ? 'skipped' : 'failed', 1, result.reason);
  }
  return releaseDefault(input);
}

/** The last resort: the release's direct default agent, else the built-in goodbye. */
export async function releaseDefault(
  input: Pick<
    FallbackInput,
    'node' | 'turn' | 'recorder' | 'defaultTarget' | 'finalLine' | 'attempt'
  >,
): Promise<FallbackResult> {
  const result = await input.attempt(input.defaultTarget);
  if (result.ok) {
    event(input, 'release_default', 'taken', 1);
    return { kind: 'resolved', resolution: result.resolution };
  }
  event(input, 'release_default', 'failed', 1, result.reason);
  return {
    kind: 'resolved',
    resolution: { kind: 'end', line: input.finalLine, degraded: 'release_default_failed' },
  };
}
