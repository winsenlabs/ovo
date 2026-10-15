import type { SegmentHistoryEntry } from './call-memory.ts';
import type { HoldPlayer } from './hold-player.ts';
import { chainStep, fallbackTarget, waitForTarget, type Waited } from './transfer-chain.ts';
import { TRANSFER_BUILT_IN_LINES, type HoldTimeoutStep } from '@winsendotai/ovo-contracts';
import { transferCompleted, type ChainStep, type TransferOutcome } from './transfer-events.ts';
import { STEP_HOLD_SECONDS, type ConnectHost, type TransferRun } from './transfer-types.ts';

/** How the current candidate came about: the request itself, or a timeout chain step. */
type Via = 'request' | 'target' | 'default' | 'return' | 'release_default';

const OUTCOME: Record<Via, TransferOutcome> = {
  request: 'connected',
  target: 'fallback',
  default: 'fallback',
  release_default: 'fallback',
  return: 'returned',
};

/**
 * After the requester's engine has ended into a committed handoff (transfer design 7.2 step 5,
 * 7.6, 7.7): holds the caller unless the target is already composed, retries a queued claim every
 * three seconds, and starts the target the moment it is ready (its first audio stops the hold).
 * A target that fails to compose, to start, or to be ready within the hold's `maxSeconds` runs
 * the hold's `onTimeout` chain, step by step, while the hold keeps playing; an exhausted chain
 * tries the routing release's default target once, then says the built-in end line and ends the
 * call. Every step is recorded in `transfer.completed.steps`. The caller hanging up, or the call's
 * own limit, ends it all at any point.
 */
export async function connectTransfer(
  host: ConnectHost,
  run: TransferRun,
  gapFrom: number,
): Promise<void> {
  const { deps, clock } = host;
  const tags = run.transfer !== undefined ? { transfer: run.transfer } : { handoffId: run.id };
  const policy = run.hold.policy;
  const hold = deps.holdPlayer(policy, tags);
  const chain = [...policy.onTimeout];
  const steps: ChainStep[] = [];
  let via: Via = 'request';
  let deadline = gapFrom + policy.maxSeconds * 1000;
  let queueMs: number | undefined;
  let reason: string | undefined;
  let triedDefault = false;
  const finish = (outcome: TransferOutcome, to?: SegmentHistoryEntry) => {
    const held = hold.started ? clock.now() - gapFrom : 0;
    if (run.transfer !== undefined)
      deps.record('transfer.completed', {
        ...transferCompleted(run, outcome, {
          ...{ holdMs: held, steps, gapMs: clock.now() - gapFrom },
          ...(to ? { to } : {}),
          ...(queueMs !== undefined ? { queueMs } : {}),
          ...(run.attempt?.prepareMs !== undefined ? { prepareMs: run.attempt.prepareMs } : {}),
          ...(outcome !== 'connected' && reason ? { reason } : {}),
        }),
      });
    else if (steps.length || outcome !== 'connected')
      deps.audit('route.handoff.chain', { outcome, steps, ...(reason ? { reason } : {}) });
    const log = outcome === 'connected' ? 'transfer_connected' : 'transfer_failed';
    deps.log(reason === 'hold_timeout' && outcome !== 'connected' ? 'transfer_hold_timeout' : log, {
      ...tags,
      ...(run.target ? { key: run.target.key } : {}),
      ...{ kind: run.request.kind, outcome, holdMs: held },
      ...(to ? { releaseId: to.releaseId, segment: to.index } : {}),
    });
  };
  /** Begins `target`-like candidates for a chain step; false when nothing could be composed. */
  const candidate = (next: Via, attempt: TransferRun['attempt']) => {
    run.attempt = attempt;
    via = next;
    deadline = clock.now() + Math.min(STEP_HOLD_SECONDS, policy.maxSeconds) * 1000;
    return Boolean(attempt || run.queue);
  };
  const terminal = async (step: Extract<HoldTimeoutStep, { kind: 'callback' | 'end' }>) => {
    if (step.kind === 'callback') {
      const dueAt = new Date(clock.now() + step.inMinutes * 60_000).toISOString();
      deps.record('disposition', {
        ...{ disposition: 'callback', reason: 'callback' },
        callback: { dueAt, source: 'route', releaseId: deps.fallback.releaseId },
      });
    }
    steps.push({ step: step.kind, result: 'taken' });
    finish(step.kind === 'callback' ? 'callback' : 'ended');
    await endWith(host, hold, step.line);
  };
  let connected = false;
  try {
    for (;;) {
      if (!run.attempt?.ready) hold.start(run.hold.source);
      const waited: Waited = await waitForTarget(host, run, Math.min(deadline, deps.callEndsAt));
      if (waited === 'ended') return finish('caller_hangup');
      if (waited === 'call_limit') {
        reason = 'time_exhausted';
        finish('failed');
        await hold.stop('call_limit');
        return await deps.endCall('max_duration');
      }
      if (waited === 'ready') {
        const queued = run.queue;
        if (queued) queueMs = clock.now() - queued.since;
        if (await host.start(run, run.attempt!, gapFrom, hold)) {
          connected = true;
          return finish(OUTCOME[via], host.deps.memory.segments.at(-1));
        }
        if (host.ended) return finish('caller_hangup');
        reason = 'start_failed';
      } else reason = waited;
      // A composition the hold gave up on is disposed whenever it lands.
      await run.attempt?.drop();
      if (run.queue?.since !== undefined && queueMs === undefined)
        queueMs = clock.now() - run.queue.since;
      run.queue = undefined;
      // The chain: each step either begins another candidate, ends the call, or is passed over.
      let next = false;
      while (!next) {
        const step = chain.shift();
        if (!step) {
          if (!triedDefault) {
            triedDefault = true;
            steps.push({ step: 'release_default', result: 'taken' });
            next = candidate('release_default', host.attempt(run, fallbackTarget(host, run)));
            if (!next) steps.at(-1)!.result = 'failed';
            continue;
          }
          finish('ended');
          return await endWith(host, hold, TRANSFER_BUILT_IN_LINES.end);
        }
        if (step.kind === 'callback' || step.kind === 'end') return await terminal(step);
        if (step.kind === 'human') {
          steps.push({ step: 'human', result: 'skipped', reason: 'human_queue_unavailable' });
          continue;
        }
        if (step.kind === 'return' && run.from.role !== 'agent') {
          steps.push({ step: 'return', result: 'skipped', reason: 'no_previous_agent' });
          continue;
        }
        const begun = await chainStep(host, run, step);
        if (typeof begun === 'string') {
          steps.push({ step: step.kind, result: 'failed', reason: begun });
          continue;
        }
        steps.push({ step: step.kind, result: 'taken' });
        next = candidate(step.kind, begun.attempt);
        if (!next) steps.at(-1)!.result = 'failed';
      }
    }
  } finally {
    host.settle(run);
    if (!connected) await hold.stop(host.ended ? 'caller_hangup' : 'chain_ended');
  }
}

/** A terminal step: the hold gives way to one line in the house voice, then the call ends. */
async function endWith(
  host: ConnectHost,
  hold: HoldPlayer,
  line: Parameters<HoldPlayer['say']>[0],
): Promise<void> {
  await hold.say(line, 'timeout_chain');
  if (!host.ended) await host.deps.endCall('behavior_completed');
}
