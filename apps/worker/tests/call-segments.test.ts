import {
  MULAW_8K,
  type HandoffPrepareResult,
  type SegmentHandoffRequest,
} from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { CallSegment } from '../src/call-segment.ts';
import {
  CallSegmentController,
  SegmentReleaseMissingError,
  type SegmentTarget,
} from '../src/call-segments.ts';
import type { SegmentMediaLease } from '../src/segment-media.ts';
import { fakeMediaLink, fakeSegment, SegmentJournal } from './segment-fixtures.ts';

type FakeSegment = ReturnType<typeof fakeSegment>;
type Compose = (
  target: SegmentTarget,
  index: number,
  lease: SegmentMediaLease,
) => Promise<CallSegment>;

const frame = (byte: number) => new Uint8Array(160).fill(byte);
const signal = () => new AbortController().signal;
const request = (releaseId = 'release-agent'): SegmentHandoffRequest => ({
  kind: 'agent',
  reason: 'route',
  agentId: 'agent-sales',
  releaseId,
  variables: { ovo_route_intent: 'sales' },
  route: { path: ['intent'], poolId: 'pool-sales', memberId: 'sales-en' },
});

async function harness(options: { compose?: Compose; fail?: string[]; timeoutMs?: number } = {}) {
  const link = fakeMediaLink();
  const journal = new SegmentJournal();
  const segments = new Map<number, FakeSegment>();
  const targets: { target: SegmentTarget; index: number }[] = [];
  const recorded: [string, Record<string, unknown>][] = [];
  const audits: [string, Record<string, unknown>][] = [];
  const releaseClaim = vi.fn(async () => undefined);
  const endCall = vi.fn((reason: string) => link.close(reason));
  const compose: Compose = async (target, index, lease) => {
    targets.push({ target, index });
    const segment = fakeSegment(`s${index}`, journal, lease, {
      ...target,
      fail: options.fail?.includes(target.releaseId),
    });
    segments.set(index, segment);
    return segment;
  };
  const controller = new CallSegmentController({
    media: link,
    format: MULAW_8K,
    allowed: new Set(['release-router', 'release-agent', 'release-default']),
    fallback: { agentId: 'agent-default', releaseId: 'release-default' },
    compose: options.compose ?? compose,
    record: (type, payload) => recorded.push([type, payload]),
    audit: (type, payload) => audits.push([type, payload]),
    releaseClaim,
    endCall,
    prepareTimeoutMs: options.timeoutMs ?? 2_500,
  });
  const lease = controller.lease(true);
  const router = fakeSegment('router', journal, lease, { releaseId: 'release-router' });
  controller.attach(router, lease);
  await router.start();
  return {
    link,
    journal,
    segments,
    targets,
    recorded,
    audits,
    releaseClaim,
    endCall,
    controller,
    router,
  };
}

function prepared(result: HandoffPrepareResult): string {
  if (!result.ok) throw new Error(`prepare failed: ${result.reason}`);
  return result.handoffId;
}

describe('CallSegmentController (routing design 7.4)', () => {
  it('swaps the router for the target on the same link, one engine at a time', async () => {
    const h = await harness();
    const handoff = prepared(await h.controller.prepare(request(), signal()));
    // Composed and pre-connected while the router speaks, not started.
    expect(h.targets).toEqual([
      {
        target: {
          agentId: 'agent-sales',
          releaseId: 'release-agent',
          variables: { ovo_route_intent: 'sales' },
        },
        index: 1,
      },
    ]);
    expect(h.journal.entries).toEqual(['router.start']);
    h.controller.commit(handoff);
    expect(h.controller.handingOff).toBe(true);
    h.link.audio(frame(1));
    await h.router.complete();
    // The caller speaks during the swap: held, then replayed into the agent.
    h.link.audio(frame(2));
    h.link.dtmf('7');
    await vi.waitFor(() => expect(h.journal.entries).toContain('s1.start'));
    h.link.audio(frame(3));
    expect(h.journal.entries).toEqual([
      'router.start',
      'router.close:behavior_completed',
      's1.start',
    ]);
    expect(h.journal.maxAttached).toBe(1);
    expect(h.link.closed).toEqual([]);
    expect(h.router.heard).toEqual(['a1']);
    expect(h.segments.get(1)!.heard).toEqual(['a2', 'd7', 'a3']);
    expect(h.recorded).toEqual([
      [
        'route.segment',
        {
          index: 1,
          role: 'agent',
          agentId: 'agent-sales',
          releaseId: 'release-agent',
          reason: 'route',
          poolId: 'pool-sales',
          memberId: 'sales-en',
          prepareMs: expect.any(Number),
          gapMs: expect.any(Number),
          gapDroppedMs: 0,
        },
      ],
    ]);
    expect(h.controller.handingOff).toBe(false);
    await h.controller.close('caller_hangup');
    expect(h.journal.entries.at(-1)).toBe('s1.close:caller_hangup');
    expect(h.link.closed).toEqual([]);
    expect(h.releaseClaim).not.toHaveBeenCalled();
  });

  it('hangs up as before when the router ends without a committed handoff', async () => {
    const h = await harness();
    prepared(await h.controller.prepare(request(), signal()));
    await h.router.complete();
    expect(h.link.closed).toEqual(['behavior_completed']);
    await h.controller.close('behavior_completed');
    expect(h.journal.entries).toEqual(['router.start', 'router.close:behavior_completed']);
    expect(h.segments.get(1)!.closeReasons).toEqual(['behavior_completed']);
  });

  it('refuses a release outside the routing snapshot, and any prepare once committed', async () => {
    const h = await harness();
    expect(await h.controller.prepare(request('release-elsewhere'), signal())).toEqual({
      ok: false,
      reason: 'release_not_allowed',
    });
    expect(h.targets).toEqual([]);
    h.controller.commit(prepared(await h.controller.prepare(request(), signal())));
    expect(await h.controller.prepare(request('release-default'), signal())).toEqual({
      ok: false,
      reason: 'busy',
    });
  });

  it('reports a missing release and a failed composition', async () => {
    let failure: Error = new SegmentReleaseMissingError('release-agent');
    const h = await harness({ compose: async () => Promise.reject(failure) });
    expect(await h.controller.prepare(request(), signal())).toEqual({
      ok: false,
      reason: 'release_missing',
    });
    failure = new Error('graph refused');
    expect(await h.controller.prepare(request(), signal())).toEqual({
      ok: false,
      reason: 'compose_failed',
    });
  });

  it('gives up a slow composition at the bound and disposes it when it arrives', async () => {
    let finish!: (segment: CallSegment) => void;
    let late: FakeSegment | undefined;
    const journal = new SegmentJournal();
    const h = await harness({
      timeoutMs: 20,
      compose: (_target, _index, lease) =>
        new Promise((resolve) => {
          late = fakeSegment('late', journal, lease);
          finish = resolve;
        }),
    });
    expect(await h.controller.prepare(request(), signal())).toEqual({
      ok: false,
      reason: 'timeout',
    });
    finish(late!);
    await vi.waitFor(() => expect(late!.closeReasons).toEqual(['error:route-handoff-failed']));
    expect(journal.entries).toEqual([]);
  });

  it('ends the prepare when the caller hangs up during it, and disposes the late graph', async () => {
    let finish!: (segment: CallSegment) => void;
    let late: FakeSegment | undefined;
    const h = await harness({
      compose: (_target, _index, lease) =>
        new Promise((resolve) => {
          late = fakeSegment('late', new SegmentJournal(), lease);
          finish = resolve;
        }),
    });
    const pending = h.controller.prepare(request(), signal());
    h.link.hangup('caller_hangup');
    expect(await pending).toEqual({ ok: false, reason: 'call_ended' });
    const closing = h.controller.close('caller_hangup');
    finish(late!);
    await closing;
    expect(late!.closeReasons).toEqual(['error:route-handoff-failed']);
    expect(h.journal.entries).toEqual(['router.start', 'router.close:caller_hangup']);
    expect(await h.controller.prepare(request(), signal())).toEqual({
      ok: false,
      reason: 'call_ended',
    });
  });

  it('keeps the hang-up when the caller leaves after the commit', async () => {
    const h = await harness();
    h.controller.commit(prepared(await h.controller.prepare(request(), signal())));
    h.link.hangup('caller_hangup');
    expect(h.controller.handingOff).toBe(false);
    await h.router.complete('caller_hangup');
    await h.controller.close('caller_hangup');
    expect(h.journal.entries).toEqual(['router.start', 'router.close:caller_hangup']);
    expect(h.segments.get(1)!.closeReasons).toEqual(['caller_hangup']);
  });

  it('abandons a prepared graph with its claim; a second prepare replaces the first', async () => {
    const h = await harness();
    const first = prepared(await h.controller.prepare(request(), signal()));
    const second = prepared(await h.controller.prepare(request('release-default'), signal()));
    expect(h.segments.get(1)!.closeReasons).toEqual(['behavior_completed']);
    expect(h.releaseClaim).not.toHaveBeenCalled();
    await h.controller.abandon(first);
    expect(h.segments.get(2)!.closeReasons).toEqual([]);
    await h.controller.abandon(second);
    await h.controller.abandon(second);
    expect(h.segments.get(2)!.closeReasons).toEqual(['behavior_completed']);
    expect(h.releaseClaim).toHaveBeenCalledOnce();
    h.controller.commit(second);
    expect(h.audits).toContainEqual([
      'route.handoff.failed',
      { handoffId: second, reason: 'commit_unknown' },
    ]);
    await h.router.complete();
    expect(h.link.closed).toEqual(['behavior_completed']);
  });

  it('tries the default release once when the target fails to start', async () => {
    const h = await harness({ fail: ['release-agent'] });
    h.controller.commit(prepared(await h.controller.prepare(request(), signal())));
    await h.router.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.journal.entries).toEqual([
      'router.start',
      'router.close:behavior_completed',
      's2.start',
    ]);
    expect(h.segments.get(1)!.closeReasons).toEqual(['error:route-handoff-failed']);
    expect(h.targets[1]).toEqual({
      target: {
        agentId: 'agent-default',
        releaseId: 'release-default',
        variables: { ovo_route_intent: 'sales' },
      },
      index: 2,
    });
    expect(h.recorded).toEqual([
      ['route.segment', expect.objectContaining({ index: 2, reason: 'fallback' })],
    ]);
    expect(h.endCall).not.toHaveBeenCalled();
    expect(h.link.closed).toEqual([]);
  });

  it('ends the call with route-handoff-failed when the default fails too', async () => {
    const h = await harness({ fail: ['release-agent', 'release-default'] });
    h.controller.commit(prepared(await h.controller.prepare(request(), signal())));
    await h.router.complete();
    await vi.waitFor(() => expect(h.endCall).toHaveBeenCalledWith('error:route-handoff-failed'));
    expect(h.link.closed).toEqual(['error:route-handoff-failed']);
    expect(h.journal.maxAttached).toBe(1);
    expect(h.recorded).toEqual([]);
    await h.controller.close('error:route-handoff-failed');
  });
});
