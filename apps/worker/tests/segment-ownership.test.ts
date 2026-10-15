import { MULAW_8K, type SegmentHandoffRequest } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { CallSegment } from '../src/call-segment.ts';
import { CallSegmentController, type SegmentTarget } from '../src/call-segments.ts';
import type { SegmentMediaLease } from '../src/segment-media.ts';
import { fakeMediaLink, fakeSegment, nativeEngine, SegmentJournal } from './segment-fixtures.ts';
import {
  agentRequest,
  flush,
  holdPolicy,
  signal,
  transferHarness,
  transferPolicy,
} from './transfer-fixtures.ts';

/**
 * Only the attached segment's engine may end a routed call (transfer design 7.1). Every fake here
 * disposes as the native engine does: its hang-up, then its media close, which reaches the call's
 * real link unless the controller keeps it. A graph that was never attached (composed, then
 * dropped, superseded or arriving after its bound) must leave the live call alone.
 */

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

/** The live call is untouched: no hang-up ran and the link is open. */
function expectLive(h: { link: ReturnType<typeof fakeMediaLink>; hangUps: string[] }) {
  expect(h.hangUps).toEqual([]);
  expect(h.link.closed).toEqual([]);
  expect(h.link.isClosed).toBe(false);
}

describe('in-call transfer: a never-attached graph never ends the call', () => {
  it('a target landing after the timeout chain returned the caller leaves the returned agent on', async () => {
    const slow = gate();
    const h = transferHarness({
      first: 'agent',
      timeoutMs: 50,
      compose: { 'release-b': slow.promise },
      policy: transferPolicy({ hold: holdPolicy({ onTimeout: [{ kind: 'return' }] }) }),
    });
    const agent = await h.started();
    const begun = await h.controller.begin(agentRequest('release-b'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await agent.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    slow.open();
    await vi.waitFor(() =>
      expect(h.segments.get(1)?.closeReasons).toEqual(['error:route-handoff-failed']),
    );
    await flush();
    expectLive(h);
    expect(h.controller.attached).toMatchObject({ index: 2, releaseId: 'release-a' });
    // The returned agent still ends the call itself.
    await h.segments.get(2)!.complete();
    expect(h.hangUps).toEqual(['behavior_completed']);
    expect(h.link.closed).toEqual(['behavior_completed']);
  });

  it('a cancel before commit disposes a composed graph, and one that lands later', async () => {
    const ready = transferHarness();
    await ready.started();
    const first = await ready.controller.begin(agentRequest('release-a', 'route'), signal());
    if (!first.ok) throw new Error(first.reason);
    await flush();
    await ready.controller.abandon(first.handoffId);
    expect(ready.segments.get(1)?.closeReasons).toEqual(['error:route-handoff-failed']);
    expectLive(ready);

    const slow = gate();
    const late = transferHarness({ compose: { 'release-a': slow.promise } });
    await late.started();
    const second = await late.controller.begin(agentRequest('release-a', 'route'), signal());
    if (!second.ok) throw new Error(second.reason);
    await late.controller.abandon(second.handoffId);
    slow.open();
    await vi.waitFor(() =>
      expect(late.segments.get(1)?.closeReasons).toEqual(['error:route-handoff-failed']),
    );
    await flush();
    expectLive(late);
  });

  it('a prepare replacing an uncommitted one, or past its bound, leaves the router on', async () => {
    const h = transferHarness();
    await h.started();
    expect(await h.controller.prepare(agentRequest('release-a', 'route'), signal())).toMatchObject({
      ok: true,
    });
    expect(await h.controller.prepare(agentRequest('release-b', 'route'), signal())).toMatchObject({
      ok: true,
    });
    expect(h.segments.get(1)?.closeReasons).toEqual(['error:route-handoff-failed']);
    expectLive(h);

    const slow = gate();
    const late = transferHarness({ compose: { 'release-a': slow.promise } });
    await late.started();
    expect(
      await late.controller.prepare(agentRequest('release-a', 'route'), signal()),
    ).toMatchObject({ ok: false, reason: 'timeout' });
    slow.open();
    await vi.waitFor(() =>
      expect(late.segments.get(1)?.closeReasons).toEqual(['error:route-handoff-failed']),
    );
    await flush();
    expectLive(late);
    expect(late.controller.attached).toMatchObject({ index: 0, role: 'router' });
  });

  it('the attached segment still ends the call, and every segment once the call has ended', async () => {
    const h = transferHarness({ compose: { 'release-a': gate().promise } });
    await h.started();
    await h.controller.begin(agentRequest('release-a', 'route'), signal());
    await h.controller.close('max_duration');
    expect(h.hangUps).toEqual(['max_duration']);
    expect(h.link.closed).toEqual(['max_duration']);
  });
});

type AgentRequest = Extract<SegmentHandoffRequest, { kind: 'agent' }>;
const request = (releaseId: string): AgentRequest => ({
  kind: 'agent',
  reason: 'route',
  agentId: `agent-of-${releaseId}`,
  releaseId,
  variables: {},
});

/** R1's controller (`OVO_ROUTING_ENABLED` with transfers off) over native-closing fakes. */
function routed(options: { slow?: Promise<void>; fail?: string[]; timeoutMs?: number } = {}) {
  const link = fakeMediaLink();
  const journal = new SegmentJournal();
  const hangUps: string[] = [];
  const segments = new Map<number, ReturnType<typeof fakeSegment>>();
  const native = (lease: SegmentMediaLease) =>
    nativeEngine(() => controller.mayEndCall(lease), hangUps);
  const controller: CallSegmentController = new CallSegmentController({
    media: link,
    format: MULAW_8K,
    allowed: new Set(['release-a', 'release-b', 'release-slow', 'release-default']),
    fallback: { agentId: 'agent-default', releaseId: 'release-default' },
    compose: async (target: SegmentTarget, index: number, lease: SegmentMediaLease) => {
      if (target.releaseId === 'release-slow') await options.slow;
      const segment = fakeSegment(`s${index}`, journal, lease, {
        ...{ releaseId: target.releaseId, agentId: target.agentId, ...native(lease) },
        fail: options.fail?.includes(target.releaseId) ?? false,
      });
      segments.set(index, segment);
      return segment as unknown as CallSegment;
    },
    record: () => undefined,
    audit: () => undefined,
    releaseClaim: async () => undefined,
    endCall: (reason) => link.close(reason),
    prepareTimeoutMs: options.timeoutMs ?? 2_500,
  });
  const lease = controller.lease(true);
  const router = fakeSegment('router', journal, lease, {
    ...{ releaseId: 'release-router', ...native(lease) },
  });
  controller.attach(router as unknown as CallSegment, lease);
  return { link, journal, hangUps, segments, controller, router };
}

describe('R1 routing: a never-attached graph never ends the call', () => {
  it('a composition landing after the prepare bound', async () => {
    const slow = gate();
    const h = routed({ slow: slow.promise, timeoutMs: 50 });
    await h.router.start();
    expect(await h.controller.prepare(request('release-slow'), signal())).toEqual({
      ok: false,
      reason: 'timeout',
    });
    slow.open();
    await vi.waitFor(() =>
      expect(h.segments.get(1)?.closeReasons).toEqual(['error:route-handoff-failed']),
    );
    await flush();
    expectLive(h);
  });

  it('an abandoned prepare, and a prepare replaced by another', async () => {
    const h = routed();
    await h.router.start();
    const first = await h.controller.prepare(request('release-a'), signal());
    if (!first.ok) throw new Error(first.reason);
    await h.controller.abandon(first.handoffId);
    expect(h.segments.get(1)?.closeReasons).toEqual(['behavior_completed']);
    expect((await h.controller.prepare(request('release-a'), signal())).ok).toBe(true);
    expect((await h.controller.prepare(request('release-b'), signal())).ok).toBe(true);
    expect(h.segments.get(2)?.closeReasons).toEqual(['behavior_completed']);
    expectLive(h);
  });

  it('a target failing to start leaves the call to the fallback', async () => {
    const h = routed({ fail: ['release-a'] });
    await h.router.start();
    const prepared = await h.controller.prepare(request('release-a'), signal());
    if (!prepared.ok) throw new Error(prepared.reason);
    h.controller.commit(prepared.handoffId);
    await h.router.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expectLive(h);
    await h.segments.get(2)!.complete();
    expect(h.hangUps).toEqual(['behavior_completed']);
    expect(h.link.closed).toEqual(['behavior_completed']);
  });
});
