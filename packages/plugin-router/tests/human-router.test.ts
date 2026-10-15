import type { RoutingReleaseSnapshot, SegmentHandoffRequest } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { exampleRoutingSnapshot } from '../src/testing.ts';
import { dtmf, opening, routerHarness } from './harness.ts';

const QUEUE_ID = '00000000-0000-4000-8000-0000000000e1';

/**
 * The example release with the queue `desk` bound (schema 3): `humanQueues` binds its key to a
 * workspace queue and `queues` pins that queue's definition by value, as publish does.
 */
function snapshot(
  patch: (raw: Record<string, any>) => void = () => {},
  queue: Record<string, unknown> | null = {
    kind: 'managed',
    name: 'Desk',
    announcement: { en: 'A colleague will take over.' },
  },
): RoutingReleaseSnapshot {
  return exampleRoutingSnapshot((raw) => {
    raw.transfer = {};
    patch(raw);
    if (queue === null) {
      raw.schemaVersion = 2;
      return;
    }
    raw.schemaVersion = 3;
    raw.humanQueues = [{ key: 'desk', queueId: QUEUE_ID, priority: 0 }];
    raw.queues = {
      [QUEUE_ID]: { id: QUEUE_ID, version: 1, key: 'desk', priority: 0, definition: queue },
    };
  });
}

const toHuman = (raw: Record<string, any>) => {
  raw.nodes[0].branches[0].target = { kind: 'human', queueId: 'desk' };
};

type Refusal =
  'no_operators' | 'queue_closed' | 'queue_full' | 'queue_unavailable' | 'queue_unknown';
const refusing = (reason: Refusal) => ({
  begin: (request: SegmentHandoffRequest) =>
    (request as { kind: string }).kind === 'human'
      ? ({ ok: false, reason } as const)
      : ({ ok: true, handoffId: 'begin-agent', state: 'preparing' } as const),
});

describe('a human target (human queue design 7.6)', () => {
  it('begins the queue, commits it, says the queue announcement and decides route:human', async () => {
    const h = routerHarness({ snapshot: snapshot(toHuman), handoff: { begin: true } });
    await h.turn('', opening);
    const reply = await h.turn('1', dtmf('1'));
    expect(reply.say).toBe('A colleague will take over.');
    expect(h.handoff.begun).toHaveLength(1);
    expect(h.handoff.begun[0]).toMatchObject({
      kind: 'human',
      reason: 'route',
      queueId: 'desk',
      variables: expect.any(Object),
      route: { path: ['intent'] },
    });
    expect(h.handoff.committed).toEqual(['begin-1']);
    expect(h.core.phase).toBe('announcing');
    expect(h.core.completionReason()).toBe('route:human:intent');
    // Ids and keys only: the decision names the target kind, no agent and no caller words.
    const decision = h.core.recorder.events.find(
      (event) => event.type === 'route.decision',
    )!.payload;
    expect(decision).toMatchObject({ target: 'human', path: ['intent'] });
    expect(decision).not.toHaveProperty('agentId');
    expect(h.core.outcome).toMatchObject({ kind: 'human', queueId: 'desk', handoffId: 'begin-1' });
  });

  it("says the built-in line, in the caller's language, when the queue authors none", async () => {
    const english = routerHarness({
      snapshot: snapshot(toHuman, { kind: 'managed', name: 'Desk' }),
      handoff: { begin: true },
    });
    await english.turn('', opening);
    expect((await english.turn('1', dtmf('1'))).say).toBe(
      "I'm connecting you to a colleague. Please hold.",
    );
  });

  it('fails the attempt on each refusal, so the node chain goes on (default agent)', async () => {
    for (const reason of [
      'no_operators',
      'queue_closed',
      'queue_full',
      'queue_unavailable',
      'queue_unknown',
    ] as const) {
      const h = routerHarness({ snapshot: snapshot(toHuman), handoff: refusing(reason) });
      await h.turn('', opening);
      await h.turn('1', dtmf('1'));
      const fallback = h.core.recorder.events
        .filter((event) => event.type === 'route.fallback')
        .map((event) => event.payload);
      // The refusal is a failed target (the chain skips its re-ask for it, recording why), and
      // the node's chain goes on to the default agent: the caller is never left waiting.
      expect(fallback).toContainEqual(expect.objectContaining({ result: 'skipped', reason }));
      expect(h.handoff.begun.map((request) => request.kind)).toEqual(['human', 'agent']);
      expect(h.core.outcome).toMatchObject({ kind: 'agent' });
    }
  });
});

describe('the human fallback step', () => {
  const chain = (raw: Record<string, any>) => {
    raw.nodes[0].fallback = [
      { kind: 'human', queueId: 'desk' },
      { kind: 'callback', line: { en: 'We will call you back.' } },
    ];
  };

  it('is taken when the queue accepts, and ends the chain there', async () => {
    const h = routerHarness({ snapshot: snapshot(chain), handoff: { begin: true } });
    await h.turn('', opening);
    const reply = await h.turn('zzz');
    expect(reply.say).toBe('A colleague will take over.');
    expect(
      h.core.recorder.events.filter((e) => e.type === 'route.fallback').map((e) => e.payload),
    ).toEqual([expect.objectContaining({ step: 'human', result: 'taken' })]);
    expect(h.core.completionReason()).toBe('route:human:intent');
  });

  it('is a failed step when the queue refuses (no operators), then the callback is offered', async () => {
    const h = routerHarness({ snapshot: snapshot(chain), handoff: refusing('no_operators') });
    await h.turn('', opening);
    const reply = await h.turn('zzz');
    expect(reply.say).toBe('We will call you back.');
    expect(
      h.core.recorder.events.filter((e) => e.type === 'route.fallback').map((e) => e.payload),
    ).toEqual([
      expect.objectContaining({ step: 'human', result: 'failed', reason: 'no_operators' }),
      expect.objectContaining({ step: 'callback', result: 'taken' }),
    ]);
  });

  it('stays skipped, exactly as in R2, for a key the release does not bind', async () => {
    const h = routerHarness({ snapshot: snapshot(chain, null), handoff: { begin: true } });
    await h.turn('', opening);
    await h.turn('zzz');
    expect(h.handoff.begun).toEqual([]);
    expect(
      h.core.recorder.events.filter((e) => e.type === 'route.fallback').map((e) => e.payload),
    ).toEqual([
      expect.objectContaining({
        step: 'human',
        result: 'skipped',
        reason: 'human_queue_unavailable',
      }),
      expect.objectContaining({ step: 'callback', result: 'taken' }),
    ]);
  });

  it('stays skipped when the host offers no begin (transfers off), even for a bound queue', async () => {
    const h = routerHarness({ snapshot: snapshot(chain) });
    await h.turn('', opening);
    await h.turn('zzz');
    expect(h.handoff.begun).toEqual([]);
    expect(h.handoff.prepared).toEqual([]);
    expect(
      h.core.recorder.events.filter((e) => e.type === 'route.fallback')[0]!.payload,
    ).toMatchObject({
      step: 'human',
      result: 'skipped',
      reason: 'human_queue_unavailable',
    });
  });

  it('treats a host that skips with human_queue_unavailable as the R2 skip', async () => {
    const h = routerHarness({
      snapshot: snapshot(chain),
      handoff: { begin: () => ({ ok: false, reason: 'human_queue_unavailable' }) as never },
    });
    await h.turn('', opening);
    await h.turn('zzz');
    expect(h.core.recorder.events.find((e) => e.type === 'route.fallback')!.payload).toMatchObject({
      result: 'skipped',
    });
  });
});
