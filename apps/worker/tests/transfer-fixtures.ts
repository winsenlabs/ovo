import {
  MULAW_8K,
  type HoldPolicy,
  type MemberClaim,
  type RouteLines,
  type RoutingMemberCandidate,
  type RoutingTransferPolicy,
} from '@winsendotai/ovo-contracts';
import { vi } from 'vitest';
import { CallMemory } from '../src/call-memory.ts';
import type { CallSegment } from '../src/call-segment.ts';
import type { HoldClock, HoldPlayer } from '../src/hold-player.ts';
import type { SegmentMediaLease } from '../src/segment-media.ts';
import { SegmentReleaseMissingError } from '../src/segment-prepare.ts';
import type { AttemptTarget } from '../src/transfer-attempt.ts';
import { TransferController } from '../src/transfer-controller.ts';
import type { ResolvedTarget, TransferControllerDeps } from '../src/transfer-types.ts';
import { fakeMediaLink, fakeSegment, SegmentJournal } from './segment-fixtures.ts';

export const POOL = '11111111-1111-4111-8111-111111111111';
export const CLAIM = '22222222-2222-4222-8222-222222222222';

/** A clock whose sleeps resolve only when the test advances it (or their signal aborts). */
export class FakeClock implements HoldClock {
  private at = 1_000_000;
  private timers: { at: number; resolve(): void }[] = [];

  now = () => this.at;

  sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = { at: this.at + ms, resolve };
      this.timers.push(timer);
      signal.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((item) => item !== timer);
          resolve();
        },
        { once: true },
      );
    });

  /** Moves time on, waking every sleep due on the way, in order. */
  async advance(ms: number): Promise<void> {
    const until = this.at + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.at = Math.max(this.at, due.at);
      due.resolve();
    }
    this.at = until;
    await flush();
  }
}

/** Lets promise chains (and a few timer turns) run. */
export async function flush(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

/** A hold player that records what it was asked to do. */
export function fakeHold(policy: HoldPolicy, tags: Record<string, unknown>) {
  const log: string[] = [];
  let started = false;
  let finished: Promise<void> | undefined;
  const hold = {
    policy,
    tags,
    log,
    get started() {
      return started;
    },
    start: (source: string) => {
      if (started || finished) return;
      started = true;
      log.push(`start:${source}`);
    },
    stop: (why: string) => (finished ??= (log.push(`stop:${why}`), Promise.resolve())),
    say: (lines: RouteLines, why: string) =>
      (finished ??= (log.push(`say:${lines.en}:${why}`), Promise.resolve())),
  };
  return hold;
}
export type FakeHold = ReturnType<typeof fakeHold>;

type Behaviour = 'ok' | 'fail' | 'missing' | 'start_fail' | 'never' | Promise<void>;

export interface HarnessOptions {
  /** How each release composes; default `ok`. A promise composes once it resolves. */
  compose?: Record<string, Behaviour>;
  policy?: RoutingTransferPolicy;
  claim?: (tiers: readonly (readonly RoutingMemberCandidate[])[]) => MemberClaim;
  resolveTarget?: TransferControllerDeps['resolveTarget'];
  /** Segment 0: the router (default), or an agent claimed from a pool member. */
  first?: 'router' | 'agent';
  callSeconds?: number;
  timeoutMs?: number;
  withoutRouter?: boolean;
  /** A release whose engine start waits for this. */
  startGate?: Record<string, Promise<void>>;
}

/** A transfer controller on a fake link with fake segments, hold, claims and clock. */
export function transferHarness(options: HarnessOptions = {}) {
  const link = fakeMediaLink();
  const journal = new SegmentJournal();
  const clock = new FakeClock();
  const memory = new CallMemory();
  const recorded: [string, Record<string, unknown>][] = [];
  const audits: [string, Record<string, unknown>][] = [];
  const logs: [string, Record<string, unknown>][] = [];
  const holds: FakeHold[] = [];
  const segments = new Map<number, ReturnType<typeof agentSegment>>();
  const targets: { target: AttemptTarget; index: number }[] = [];
  const claims = {
    claim: vi.fn(async (tiers: readonly (readonly RoutingMemberCandidate[])[]) =>
      options.claim
        ? options.claim(tiers)
        : ({ kind: 'claimed', claimId: CLAIM, candidate: tiers[0]![0]! } as MemberClaim),
    ),
    release: vi.fn(async () => undefined),
  };
  const endCall = vi.fn((reason: string) => link.close(reason));
  const compose = async (target: AttemptTarget, index: number, lease: SegmentMediaLease) => {
    targets.push({ target, index });
    const behaviour = options.compose?.[target.releaseId] ?? 'ok';
    if (behaviour === 'never') await new Promise(() => undefined);
    if (behaviour instanceof Promise) await behaviour;
    if (behaviour === 'fail') throw new Error('graph refused');
    if (behaviour === 'missing') throw new SegmentReleaseMissingError(target.releaseId);
    const segment = agentSegment(`s${index}`, journal, lease, {
      releaseId: target.releaseId,
      agentId: target.agentId || `agent-of-${target.releaseId}`,
      fail: behaviour === 'start_fail',
    });
    const gate = options.startGate?.[target.releaseId];
    if (gate) {
      const start = segment.start;
      segment.start = async () => {
        await gate;
        await start();
      };
    }
    segments.set(index, segment);
    return segment as unknown as CallSegment;
  };
  const allowed = ['release-router', 'release-a', 'release-b', 'release-c', 'release-default'];
  const controller = new TransferController({
    media: link,
    format: MULAW_8K,
    allowed: new Set(allowed),
    fallback: { agentId: 'agent-default', releaseId: 'release-default' },
    ...(options.withoutRouter ? {} : { router: { agentId: 'front', releaseId: 'release-router' } }),
    ...(options.policy ? { policy: options.policy } : {}),
    memory,
    compose,
    record: (type, payload) => recorded.push([type, payload]),
    audit: (type, payload) => audits.push([type, payload]),
    log: (event, fields) => logs.push([event, fields]),
    claims,
    ...(options.resolveTarget ? { resolveTarget: options.resolveTarget } : {}),
    holdPlayer: (policy, tags) => {
      const hold = fakeHold(policy, tags);
      holds.push(hold);
      return hold as unknown as HoldPlayer;
    },
    endCall,
    callEndsAt: clock.now() + (options.callSeconds ?? 600) * 1000,
    defaultLanguage: 'en',
    prepareTimeoutMs: options.timeoutMs ?? 200,
    clock,
  });
  const lease = controller.lease(true);
  const agent = options.first === 'agent';
  const first = agentSegment(agent ? 'a' : 'router', journal, lease, {
    releaseId: agent ? 'release-a' : 'release-router',
    agentId: agent ? 'agent-a' : 'front',
  });
  controller.attach(
    first as unknown as CallSegment,
    lease,
    agent ? { role: 'agent', poolId: POOL, memberId: 'member-a' } : { role: 'router' },
  );
  const types = () => recorded.map(([type]) => type);
  const event = (type: string) => recorded.find(([name]) => name === type)?.[1];
  return {
    ...{ link, journal, clock, memory, recorded, audits, logs, holds, segments, targets },
    ...{ claims, endCall, controller, first, types, event },
    started: async () => {
      await first.start();
      return first;
    },
  };
}

/** `fakeSegment` with a release config and a voice: `speak` sends audio as its engine would. */
export function agentSegment(
  name: string,
  journal: SegmentJournal,
  lease: SegmentMediaLease,
  options: { releaseId: string; agentId: string; fail?: boolean },
) {
  const segment = fakeSegment(name, journal, lease, options);
  Object.assign(segment.release, {
    config: { language: 'en', variables: { type: 'object', additionalProperties: true } },
  });
  return Object.assign(segment, {
    speak: () => lease.sendAudio(new Uint8Array(160).fill(7)),
  });
}

/** An agent request for the controller's `begin`. */
export function agentRequest(releaseId: string, reason: 'route' | 'transfer' = 'transfer') {
  return {
    kind: 'agent' as const,
    reason,
    agentId: `agent-of-${releaseId}`,
    releaseId,
    variables: { ovo_route_intent: 'billing' },
    ...(reason === 'transfer' ? { transfer: { source: 'llm' as const, key: 'billing' } } : {}),
  };
}

export const signal = () => new AbortController().signal;

export const holdPolicy = (overrides: Partial<HoldPolicy> = {}): HoldPolicy => ({
  steps: [{ kind: 'silence', seconds: 3 }],
  loopFrom: 0,
  maxSeconds: 30,
  waitForCapacity: false,
  onTimeout: [{ kind: 'end', line: { en: 'Goodbye.' } }],
  ...overrides,
});

export const transferPolicy = (
  overrides: Partial<RoutingTransferPolicy> = {},
): RoutingTransferPolicy => ({
  targets: [],
  confirm: 'never',
  limits: { maxTransfers: 3, returnToPrevious: 'refuse', minRemainingSeconds: 30 },
  handover: { summary: true, transcriptTurns: 6, capturedVariables: true },
  ...overrides,
});

export type { ResolvedTarget };
