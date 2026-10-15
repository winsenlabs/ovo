import { describe, expect, it, vi } from 'vitest';
import { handoffMediaClose } from '../src/router-graph.ts';
import {
  agentRequest,
  CLAIM,
  flush,
  holdPolicy,
  POOL,
  signal,
  transferHarness,
  transferPolicy,
} from './transfer-fixtures.ts';

const frame = (byte: number) => new Uint8Array(160).fill(byte);

describe('TransferController: begin, commit and swap (transfer design 7.1, 7.2)', () => {
  it('composes in the background and swaps at once when the target is ready', async () => {
    const h = transferHarness();
    const router = await h.started();
    const begun = await h.controller.begin(agentRequest('release-a', 'route'), signal());
    expect(begun).toMatchObject({ ok: true, state: 'preparing' });
    if (!begun.ok) return;
    await flush();
    h.controller.commit(begun.handoffId);
    expect(h.controller.handingOff).toBe(true);
    await router.complete();
    await vi.waitFor(() => expect(h.segments.get(1)?.closeReasons).toBeDefined());
    await vi.waitFor(() => expect(h.journal.entries).toContain('s1.start'));
    expect(h.journal.entries).toEqual([
      'router.start',
      'router.close:behavior_completed',
      's1.start',
    ]);
    expect(h.journal.maxAttached).toBe(1);
    expect(h.link.closed).toEqual([]);
    expect(h.holds[0]!.log).toEqual([]);
    expect(h.controller.handingOff).toBe(false);
    expect(h.event('segment.ended')).toMatchObject({ index: 0, role: 'router', ended: 'handoff' });
    expect(h.event('route.segment')).toMatchObject({
      index: 1,
      role: 'agent',
      reason: 'route',
      releaseId: 'release-a',
      fromIndex: 0,
    });
    expect(h.types()).not.toContain('transfer.completed');
  });

  it("holds while the target composes; the target's first audio stops the hold first", async () => {
    let ready!: () => void;
    const composing = new Promise<void>((resolve) => (ready = resolve));
    const h = transferHarness({ first: 'agent', compose: { 'release-b': composing } });
    const agent = await h.started();
    const begun = await h.controller.begin(agentRequest('release-b'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await agent.complete();
    await vi.waitFor(() => expect(h.holds[0]?.log).toEqual(['start:default']));
    expect(h.journal.entries).toEqual(['a.start', 'a.close:behavior_completed']);
    // Caller audio during the hold reaches no engine: the target's lease is still held.
    h.link.audio(frame(1));
    ready();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s1.start'));
    const target = h.segments.get(1)!;
    expect(target.heard).toEqual([]);
    expect(h.holds[0]!.log).toEqual(['start:default']);
    await target.speak();
    expect(h.holds[0]!.log).toEqual(['start:default', 'stop:target_audio']);
    expect(h.link.sent).toEqual(['audio']);
    expect(h.event('transfer.completed')).toMatchObject({
      transfer: 1,
      outcome: 'connected',
      toSegment: 1,
      releaseId: 'release-b',
      holdPolicy: 'default',
      steps: [],
    });
    expect(h.event('route.segment')).toMatchObject({ reason: 'transfer', transfer: 1 });
    expect(h.logs.map(([name]) => name)).toContain('transfer_connected');
  });

  it("suppresses every segment's hang-up only while the call hands on", async () => {
    const h = transferHarness({ first: 'agent' });
    const agent = await h.started();
    const close = vi.fn(async () => undefined);
    const hook = handoffMediaClose(() => h.controller.handingOff, close);
    await hook('behavior_completed');
    expect(close).toHaveBeenCalledOnce();
    const begun = await h.controller.begin(agentRequest('release-b'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    await hook('transferred');
    expect(close).toHaveBeenCalledTimes(2);
    h.controller.commit(begun.handoffId);
    await hook('transferred');
    expect(close).toHaveBeenCalledTimes(2);
    await agent.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s1.start'));
    await hook('caller_hangup');
    expect(close).toHaveBeenCalledTimes(3);
    // The target's own ending hangs up as any segment's does.
    await h.segments.get(1)!.complete();
    expect(h.link.closed).toEqual(['behavior_completed']);
  });

  it('cancel before commit disposes the graph, even one that lands later, and the claim', async () => {
    let ready!: () => void;
    const composing = new Promise<void>((resolve) => (ready = resolve));
    const h = transferHarness({ compose: { 'release-a': composing } });
    await h.started();
    const begun = await h.controller.begin(agentRequest('release-a', 'route'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    await h.controller.abandon(begun.handoffId);
    expect(h.claims.release).toHaveBeenCalledOnce();
    ready();
    await vi.waitFor(() =>
      expect(h.segments.get(1)?.closeReasons).toEqual(['error:route-handoff-failed']),
    );
    expect(h.journal.entries).toEqual(['router.start']);
    h.controller.commit(begun.handoffId);
    expect(h.audits).toContainEqual([
      'route.handoff.failed',
      expect.objectContaining({ reason: 'commit_unknown' }),
    ]);
    expect(h.controller.handingOff).toBe(false);
  });

  it('refuses what it can check at once, and composes nothing for a refusal', async () => {
    const h = transferHarness({ callSeconds: 600, withoutRouter: true });
    await h.started();
    const refuse = async (request: Parameters<typeof h.controller.begin>[0], aborted = false) => {
      const controller = new AbortController();
      if (aborted) controller.abort();
      return h.controller.begin(request, controller.signal);
    };
    expect(await refuse(agentRequest('release-x'))).toEqual({
      ok: false,
      reason: 'release_not_allowed',
    });
    expect(await refuse(agentRequest('release-a'), true)).toEqual({
      ok: false,
      reason: 'call_ended',
    });
    const node = {
      kind: 'node' as const,
      reason: 'transfer' as const,
      node: 'language',
      variables: {},
      transfer: { source: 'llm' as const },
    };
    expect(await refuse(node)).toEqual({ ok: false, reason: 'unsupported' });
    expect(h.targets).toEqual([]);
    expect(await refuse(agentRequest('release-a'))).toMatchObject({ ok: true });
    expect(await refuse(agentRequest('release-b'))).toEqual({ ok: false, reason: 'busy' });
    const late = transferHarness({ callSeconds: 0 });
    await late.started();
    expect(await late.controller.begin(agentRequest('release-a'), signal())).toEqual({
      ok: false,
      reason: 'time_exhausted',
    });
  });

  it('releases the member a refused route handoff claimed (R1 8.2), never on busy', async () => {
    const h = transferHarness();
    await h.started();
    const claimed = {
      ...agentRequest('release-x', 'route'),
      route: { path: [], poolId: POOL, memberId: 'm', claimId: CLAIM },
    };
    expect(await h.controller.begin(claimed, signal())).toEqual({
      ok: false,
      reason: 'release_not_allowed',
    });
    expect(h.claims.release).toHaveBeenCalledOnce();
    await h.controller.begin(agentRequest('release-a', 'route'), signal());
    await h.controller.begin({ ...claimed, releaseId: 'release-b' }, signal());
    expect(h.claims.release).toHaveBeenCalledOnce();
  });

  it('keeps R1 prepare for agents: it waits for the graph and refuses other kinds', async () => {
    const h = transferHarness({ compose: { 'release-b': 'fail' } });
    const router = await h.started();
    const queue = {
      kind: 'queue' as const,
      reason: 'route' as const,
      poolId: POOL,
      tiers: [],
      variables: {},
    };
    expect(await h.controller.prepare(queue, signal())).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(await h.controller.prepare(agentRequest('release-b', 'route'), signal())).toEqual({
      ok: false,
      reason: 'compose_failed',
    });
    const prepared = await h.controller.prepare(agentRequest('release-a', 'route'), signal());
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(h.segments.get(2)).toBeDefined();
    h.controller.commit(prepared.handoffId);
    await router.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
  });
});

describe('TransferController: re-routes and the hold after start (transfer design 7.5, 7.6)', () => {
  it('re-routes through a node: the router comes back with its entry, under the same transfer', async () => {
    const h = transferHarness({ first: 'agent' });
    const agent = await h.started();
    h.memory.observe('route.decision', {
      path: ['intent'],
      language: 'hi',
      context: { intent: 'sales' },
    });
    h.memory.observe('disclosure', { kinds: ['recording'] });
    const node = {
      kind: 'node' as const,
      reason: 'transfer' as const,
      node: 'language',
      variables: {},
      transfer: { source: 'llm' as const, key: 'another_language' },
    };
    const begun = await h.controller.begin(node, signal());
    if (!begun.ok) throw new Error(begun.reason);
    expect(h.targets[0]!.target).toMatchObject({
      role: 'router',
      reason: 'reroute',
      releaseId: 'release-router',
      entry: {
        node: 'language',
        path: ['intent'],
        context: { language: 'hi', values: { intent: 'sales' } },
        disclosed: ['recording'],
        transfer: 1,
      },
    });
    h.controller.commit(begun.handoffId);
    await agent.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s1.start'));
    expect(h.event('route.segment')).toMatchObject({
      role: 'router',
      reason: 'reroute',
      transfer: 1,
    });
    expect(h.types()).not.toContain('transfer.completed');
    // The router's own handoff from the re-route counts under the same transfer.
    const handoff = await h.controller.begin(agentRequest('release-b'), signal());
    expect(handoff).toMatchObject({ ok: true });
    expect(h.controller.transfers).toBe(1);
  });

  it('stops the hold once a started target has stayed silent for five seconds', async () => {
    let ready!: () => void;
    const composing = new Promise<void>((resolve) => (ready = resolve));
    const h = transferHarness({ first: 'agent', compose: { 'release-b': composing } });
    const agent = await h.started();
    const begun = await h.controller.begin(agentRequest('release-b'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await agent.complete();
    ready();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s1.start'));
    await h.clock.advance(4_999);
    expect(h.holds[0]!.log).toEqual(['start:default']);
    await h.clock.advance(1);
    expect(h.holds[0]!.log).toEqual(['start:default', 'stop:target_silent']);
  });
});

describe('TransferController: queued transfers (transfer design 7.4)', () => {
  const tiers = [[{ poolId: POOL, memberId: 'b', agentId: 'agent-b', releaseId: 'release-b' }]];
  const queue = {
    kind: 'queue' as const,
    reason: 'transfer' as const,
    poolId: POOL,
    tiers,
    variables: {},
    transfer: { source: 'llm' as const, key: 'billing' },
  };

  it('refuses a full pool unless the hold waits for capacity', async () => {
    const h = transferHarness({ first: 'agent', claim: () => ({ kind: 'full' }) });
    await h.started();
    expect(await h.controller.begin(queue, signal())).toEqual({ ok: false, reason: 'pool_full' });
  });

  it('claims again every three seconds while holding and connects once a member is free', async () => {
    let full = 3;
    const h = transferHarness({
      first: 'agent',
      policy: transferPolicy({ hold: holdPolicy({ waitForCapacity: true, maxSeconds: 60 }) }),
      claim: (asked) =>
        full-- > 0
          ? { kind: 'full' }
          : { kind: 'claimed', claimId: CLAIM, candidate: asked[0]![0]! },
    });
    const agent = await h.started();
    const begun = await h.controller.begin(queue, signal());
    expect(begun).toMatchObject({ ok: true, state: 'queued' });
    if (!begun.ok) return;
    h.controller.commit(begun.handoffId);
    await agent.complete();
    await vi.waitFor(() => expect(h.holds[0]?.log).toEqual(['start:point']));
    await h.clock.advance(3_000);
    expect(h.claims.claim).toHaveBeenCalledTimes(2);
    expect(h.audits.filter(([type]) => type === 'transfer.claim.retry')).toHaveLength(1);
    await h.clock.advance(3_000);
    expect(h.claims.claim).toHaveBeenCalledTimes(3);
    await h.clock.advance(3_000);
    await vi.waitFor(() => expect(h.journal.entries).toContain('s1.start'));
    expect(h.targets[0]!.target).toMatchObject({ poolId: POOL, memberId: 'b', claimId: CLAIM });
    expect(h.event('transfer.completed')).toMatchObject({
      outcome: 'connected',
      queueMs: 9_000,
      poolId: POOL,
      memberId: 'b',
      holdPolicy: 'point',
    });
  });
});
