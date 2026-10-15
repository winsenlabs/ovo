import type { HoldTimeoutStep } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  agentRequest,
  CLAIM,
  holdPolicy,
  POOL,
  signal,
  transferHarness,
  transferPolicy,
  type HarnessOptions,
} from './transfer-fixtures.ts';

/** An agent (claimed from a pool member) transfers to `releaseId` under a hold with `onTimeout`. */
async function transferring(
  onTimeout: HoldTimeoutStep[],
  options: HarnessOptions & { releaseId?: string; reason?: 'route' | 'transfer' } = {},
) {
  const h = transferHarness({
    first: options.reason === 'route' ? 'router' : 'agent',
    policy: transferPolicy({ hold: holdPolicy({ onTimeout, maxSeconds: 20 }) }),
    ...options,
  });
  const first = await h.started();
  const begun = await h.controller.begin(
    agentRequest(options.releaseId ?? 'release-b', options.reason ?? 'transfer'),
    signal(),
  );
  if (!begun.ok) throw new Error(begun.reason);
  h.controller.commit(begun.handoffId);
  await first.complete();
  return h;
}

const completed = (h: ReturnType<typeof transferHarness>) =>
  h.recorded.filter(([type]) => type === 'transfer.completed').map(([, payload]) => payload);

describe('the hold timeout chain (transfer design 7.7)', () => {
  it('a failed composition takes the next step: the default target answers', async () => {
    const h = await transferring([{ kind: 'default' }, { kind: 'end', line: { en: 'Bye.' } }], {
      compose: { 'release-b': 'fail' },
    });
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.targets.map(({ target }) => target.releaseId)).toEqual([
      'release-b',
      'release-default',
    ]);
    expect(completed(h)).toEqual([
      expect.objectContaining({
        outcome: 'fallback',
        releaseId: 'release-default',
        reason: 'compose_failed',
        steps: [{ step: 'default', result: 'taken' }],
      }),
    ]);
    // The call held member a's claim; the default target has none, so it is let go.
    expect(h.claims.release).toHaveBeenCalledOnce();
    expect(h.event('route.segment')).toMatchObject({ reason: 'transfer', index: 2 });
  });

  it('a target that fails to start runs the chain too', async () => {
    const h = await transferring([{ kind: 'default' }], { compose: { 'release-b': 'start_fail' } });
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.types()).toContain('segment.ended');
    expect(h.recorded.filter(([type]) => type === 'segment.ended').map(([, p]) => p.ended)).toEqual(
      ['handoff', 'start_failed'],
    );
    expect(completed(h)[0]).toMatchObject({ outcome: 'fallback', reason: 'start_failed' });
  });

  it("gives up at the hold's maxSeconds, then steps on; a late graph is disposed", async () => {
    let ready!: () => void;
    const slow = new Promise<void>((resolve) => (ready = resolve));
    const h = await transferring([{ kind: 'end', line: { en: 'Bye.' } }], {
      compose: { 'release-b': slow },
      timeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(h.holds[0]?.log).toEqual(['start:point']));
    await h.clock.advance(20_000);
    await vi.waitFor(() => expect(h.endCall).toHaveBeenCalledWith('behavior_completed'));
    expect(h.holds[0]!.log).toEqual(['start:point', 'say:Bye.:timeout_chain']);
    expect(completed(h)).toEqual([
      expect.objectContaining({ outcome: 'ended', reason: 'hold_timeout' }),
    ]);
    expect(h.logs.map(([event]) => event)).toContain('transfer_hold_timeout');
    ready();
    await vi.waitFor(() =>
      expect(h.segments.get(1)?.closeReasons).toEqual(['error:route-handoff-failed']),
    );
    expect(h.journal.entries).not.toContain('s1.start');
  });

  it('a target step is gated like a transfer; a refusal or its own key is a failed step', async () => {
    const resolveTarget = vi.fn(async (key: string) =>
      key === 'closed'
        ? { refusal: 'no_eligible_member' }
        : {
            request: agentRequest('release-c'),
            target: {
              key,
              description: 'Senior',
              destination: { kind: 'node' as const, node: 'x' },
            },
            claimed: false,
          },
    );
    const h = await transferring(
      [
        { kind: 'target', key: 'billing' },
        { kind: 'target', key: 'closed' },
        { kind: 'target', key: 'senior' },
        { kind: 'end', line: { en: 'Bye.' } },
      ],
      { compose: { 'release-b': 'fail' }, resolveTarget },
    );
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(resolveTarget.mock.calls.map(([key]) => key)).toEqual(['closed', 'senior']);
    expect(completed(h)[0]).toMatchObject({
      outcome: 'fallback',
      releaseId: 'release-c',
      steps: [
        { step: 'target', result: 'failed', reason: 'own_key' },
        { step: 'target', result: 'failed', reason: 'no_eligible_member' },
        { step: 'target', result: 'taken' },
      ],
    });
  });

  it("names a target step of the router's own handoff a route fallback", async () => {
    const resolveTarget = vi.fn(async (key: string) => ({
      request: agentRequest('release-c'),
      target: { key, description: 'Desk', destination: { kind: 'node' as const, node: 'x' } },
      claimed: false,
    }));
    const h = await transferring([{ kind: 'target', key: 'desk' }, { kind: 'default' }], {
      compose: { 'release-a': 'fail' },
      releaseId: 'release-a',
      reason: 'route',
      resolveTarget,
    });
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.event('route.segment')).toMatchObject({ releaseId: 'release-c', reason: 'fallback' });
  });

  it('return re-claims the member the caller left and says so in the handover', async () => {
    const h = await transferring([{ kind: 'return' }, { kind: 'end', line: { en: 'Bye.' } }], {
      compose: { 'release-b': 'fail' },
    });
    await vi.waitFor(() => expect(h.journal.entries).toContain('s2.start'));
    expect(h.claims.claim).toHaveBeenCalledWith([
      [{ poolId: POOL, memberId: 'member-a', agentId: 'agent-a', releaseId: 'release-a' }],
    ]);
    expect(h.targets[1]!.target).toMatchObject({
      releaseId: 'release-a',
      reason: 'return',
      poolId: POOL,
      claimId: CLAIM,
    });
    expect(h.controller.handover(2, { variables: {} })).toMatchObject({
      kind: 'return',
      transfer: 1,
    });
    expect(completed(h)[0]).toMatchObject({
      outcome: 'returned',
      steps: [{ step: 'return', result: 'taken' }],
    });
    expect(h.event('route.segment')).toMatchObject({ reason: 'return', memberId: 'member-a' });
  });

  it("skips return on the router's own handoff and a human queue (R3), then calls back", async () => {
    const h = await transferring(
      [
        { kind: 'return' },
        { kind: 'human', queueId: 'desk' },
        { kind: 'callback', inMinutes: 60, line: { en: 'We will call you back.' } },
      ],
      { compose: { 'release-a': 'fail' }, releaseId: 'release-a', reason: 'route' },
    );
    await vi.waitFor(() => expect(h.endCall).toHaveBeenCalledWith('behavior_completed'));
    expect(h.holds[0]!.log.at(-1)).toBe('say:We will call you back.:timeout_chain');
    const disposition = h.event('disposition')!;
    expect(disposition).toMatchObject({
      disposition: 'callback',
      callback: { source: 'route', timezone: 'Asia/Kolkata', releaseId: 'release-default' },
    });
    const due = Date.parse((disposition.callback as { dueAt: string }).dueAt);
    expect(due - h.clock.now()).toBe(60 * 60_000);
    // The router's handoff is not a transfer: its chain is an audit, not `transfer.completed`.
    expect(completed(h)).toEqual([]);
    expect(h.audits).toContainEqual([
      'route.handoff.chain',
      expect.objectContaining({
        outcome: 'callback',
        steps: [
          { step: 'return', result: 'skipped', reason: 'no_previous_agent' },
          { step: 'human', result: 'skipped', reason: 'human_queue_unavailable' },
          { step: 'callback', result: 'taken' },
        ],
      }),
    ]);
  });

  it('an exhausted chain tries the release default once, then ends with the built-in line', async () => {
    const h = await transferring([{ kind: 'human', queueId: 'desk' }], {
      compose: { 'release-b': 'fail', 'release-default': 'missing' },
    });
    await vi.waitFor(() => expect(h.endCall).toHaveBeenCalledWith('behavior_completed'));
    expect(h.holds[0]!.log.at(-1)).toMatch(/^say:Sorry, we could not connect your call/);
    expect(completed(h)[0]).toMatchObject({
      outcome: 'ended',
      reason: 'release_missing',
      steps: [
        { step: 'human', result: 'skipped', reason: 'human_queue_unavailable' },
        { step: 'release_default', result: 'taken' },
      ],
    });
  });

  it('ends the call at its own limit while holding', async () => {
    const h = await transferring([{ kind: 'end', line: { en: 'Bye.' } }], {
      compose: { 'release-b': 'never' },
      timeoutMs: 600_000,
      callSeconds: 10,
    });
    await vi.waitFor(() => expect(h.holds[0]?.started).toBe(true));
    await h.clock.advance(10_000);
    await vi.waitFor(() => expect(h.endCall).toHaveBeenCalledWith('max_duration'));
    expect(completed(h)[0]).toMatchObject({ outcome: 'failed', reason: 'time_exhausted' });
    expect(h.holds[0]!.log.at(-1)).toBe('stop:call_limit');
  });
});

describe('a caller hang-up in every state of a transfer', () => {
  const states = ['begun', 'committed', 'holding', 'starting', 'connected'] as const;

  it.each(states)('%s: nothing is left composed, attached or holding', async (state) => {
    let ready!: () => void;
    const composing = new Promise<void>((resolve) => (ready = resolve));
    let opened!: () => void;
    const gate = new Promise<void>((resolve) => (opened = resolve));
    const h = transferHarness({
      first: 'agent',
      compose: { 'release-b': composing },
      startGate: { 'release-b': state === 'starting' ? gate : Promise.resolve() },
    });
    const agent = await h.started();
    const begun = await h.controller.begin(agentRequest('release-b'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    if (state !== 'begun') h.controller.commit(begun.handoffId);
    if (['holding', 'starting', 'connected'].includes(state)) {
      await agent.complete();
      await vi.waitFor(() => expect(h.holds[0]?.started).toBe(true));
    }
    if (state === 'starting' || state === 'connected') {
      ready();
      await vi.waitFor(() => expect(h.segments.get(1)).toBeDefined());
    }
    if (state === 'connected')
      await vi.waitFor(() => expect(h.journal.entries).toContain('s1.start'));
    h.link.hangup('caller_hangup');
    const closing = h.controller.close('caller_hangup');
    opened();
    ready();
    await closing;
    await vi.waitFor(() => {
      const composed = h.segments.get(1);
      if (composed) expect(composed.closeReasons.length).toBeGreaterThan(0);
    });
    // Everything the call composed or attached is disposed once it has ended.
    expect(agent.closeReasons.length).toBeGreaterThan(0);
    for (const segment of h.segments.values())
      expect(segment.closeReasons.length).toBeGreaterThan(0);
    expect(h.endCall).not.toHaveBeenCalled();
    expect(h.controller.handingOff).toBe(false);
    for (const hold of h.holds) if (hold.started) expect(hold.log.at(-1)).toMatch(/^stop:/);
    const outcome = completed(h)[0]?.outcome;
    if (state === 'begun') expect(outcome).toBeUndefined();
    else if (state === 'connected') expect(outcome).toBe('connected');
    else expect(outcome).toBe('caller_hangup');
  });
});
