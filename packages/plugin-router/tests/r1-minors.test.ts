import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  Cap,
  RoutingHours,
  type Behavior,
  type HandoffPrepareResult,
  type MemberClaim,
  type RoutingMemberCandidate,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { createRouterBehaviorPlugin } from '../src/index.ts';
import { isOpen } from '../src/hours.ts';
import {
  exampleRoutingSnapshot,
  EXAMPLE_IDS as I,
  fakeRoutingHost,
  fakeSegmentHandoffPort,
} from '../src/testing.ts';
import { dtmf, opening, routerHarness, type Harness } from './harness.ts';

/** R1 audit gap 4: the router minors, each with a test that fails when its guard is removed. */
const full = (): MemberClaim => ({ kind: 'full' });
const noReask = (raw: Record<string, any>) => (raw.nodes[0].fallback = [{ kind: 'default' }]);

describe('a failed branch target records why (4a)', () => {
  it('as a `target` step when no re-ask is left to record it', async () => {
    const h = routerHarness({ patch: noReask, host: { claim: full } });
    await h.turn('', opening);
    await h.turn('1', dtmf('1'));
    expect(h.of('route.fallback')).toEqual([
      {
        turn: 1,
        node: 'intent',
        step: 'target',
        result: 'failed',
        attempt: 1,
        reason: 'pool_full',
      },
      { turn: 1, node: 'intent', step: 'default', result: 'taken', attempt: 1 },
    ]);
  });

  it('not twice when a re-ask step records it', async () => {
    const h = routerHarness({ host: { claim: full } });
    await h.turn('', opening);
    await h.turn('1', dtmf('1'));
    expect(h.of('route.fallback').map((event) => event.step)).toEqual(['reask', 'default']);
    expect(h.of('route.fallback')[0]).toMatchObject({ result: 'skipped', reason: 'pool_full' });
  });
});

describe('nothing is prepared or begun once the turn is cancelled (4b)', () => {
  const cancelledWhileClaiming = (begin: boolean) => {
    let h!: Harness;
    h = routerHarness({
      ...(begin ? { handoff: { begin: true } } : {}),
      host: {
        claim: (tiers) => {
          h.behavior.cancel();
          return { kind: 'claimed', claimId: I.routingPoint, candidate: tiers[0]![0]! };
        },
      },
    });
    return h;
  };

  it.each([
    ['prepare', false],
    ['begin', true],
  ])('%s', async (_name, begin) => {
    const h = cancelledWhileClaiming(begin);
    await h.turn('', opening);
    expect((await h.turn('1', dtmf('1'))).say).toBe('');
    expect(h.handoff.prepared).toEqual([]);
    expect(h.handoff.begun).toEqual([]);
    expect(h.core.phase).toBe('routing');
  });
});

describe('guards without a killing test before (4d)', () => {
  it('a turn cancelled after its handoff was prepared never commits it', async () => {
    let h!: Harness;
    h = routerHarness({
      host: { claim: full },
      seen: (type, payload) => {
        if (type === 'route.fallback' && payload.result === 'taken') h.behavior.cancel();
      },
    });
    await h.turn('', opening);
    expect((await h.turn('1', dtmf('1'))).say).toBe('');
    expect(h.handoff.prepared).toHaveLength(1);
    expect(h.handoff.committed).toEqual([]);
    expect(h.handoff.abandoned).toEqual(['handoff-1']);
    expect(h.types()).not.toContain('route.decision');
  });

  it('a member whose release the snapshot does not list is never prepared', async () => {
    const stray: RoutingMemberCandidate = {
      poolId: I.salesPool,
      memberId: 'sales-en',
      agentId: 'sales-en',
      releaseId: '00000000-0000-4000-8000-0000000000ff',
    };
    const h = routerHarness({
      patch: noReask,
      host: { claim: () => ({ kind: 'claimed', claimId: I.routingPoint, candidate: stray }) },
    });
    await h.turn('', opening);
    await h.turn('1', dtmf('1'));
    expect(
      h.handoff.prepared.map((request) => request.kind === 'agent' && request.releaseId),
    ).toEqual([I.salesEn]);
    expect(h.of('route.fallback')[0]).toMatchObject({
      step: 'target',
      reason: 'release_not_allowed',
    });
  });

  it('disposing the session abandons a handoff its turn is still preparing', async () => {
    let resolve!: (value: HandoffPrepareResult) => void;
    const handoff = fakeSegmentHandoffPort({
      prepare: () => new Promise<HandoffPrepareResult>((done) => (resolve = done)),
    });
    const service = (key: string, value: unknown) =>
      definePlugin(
        {
          id: `fixture.${key}`,
          version: '0.1.0',
          contractVersion: 1,
          scope: 'session',
          requires: [],
          provides: [key],
          configSchema: { type: 'object' },
          secretFields: [],
        },
        (ctx) => (ctx as unknown as { provide(k: string, v: unknown): void }).provide(key, value),
      );
    const services = [
      service(Cap.routing, fakeRoutingHost()),
      service(Cap.segmentHandoff, handoff),
    ];
    const plugin = createRouterBehaviorPlugin();
    const config = {
      agent: AgentConfig.parse({ name: 'Front desk', mode: 'agent' }),
      workspaceId: 'ws-1',
      sessionId: 'call-1',
      routing: exampleRoutingSnapshot(),
    };
    const composition = await compose(
      [...services.map((s) => ({ id: s.manifest.id })), { id: plugin.manifest.id, config }],
      [...services, plugin],
    );
    const behavior = composition.ctx.get(Cap.behavior) as Behavior;
    await behavior.respond('', { inputEvent: 'opening' });
    const turn = behavior.respond('1', { inputEvent: 'dtmf', digits: '1' });
    await new Promise((done) => setTimeout(done, 0));
    await composition.dispose();
    resolve({ ok: true, handoffId: 'late' });
    await turn;
    expect(handoff.abandoned).toEqual(['late']);
    expect(handoff.committed).toEqual([]);
  });
});

describe('hours: a window may end at 24:00 (4c)', () => {
  const allDay = (end: string) =>
    RoutingHours.parse({ timezone: 'Asia/Kolkata', weekly: { thu: [{ start: '00:00', end }] } });
  // 2026-10-15 is a Thursday; 23:59:30 in Kolkata is 18:29:30 UTC.
  const lastMinute = Date.parse('2026-10-15T18:29:30Z');

  it('24:00 keeps the last minute of the day open', () => {
    expect(isOpen(allDay('24:00'), lastMinute)).toBe(true);
    expect(isOpen(allDay('24:00'), Date.parse('2026-10-15T18:30:00Z'))).toBe(false);
  });

  it('23:59 still excludes its end minute, as before', () => {
    expect(isOpen(allDay('23:59'), lastMinute)).toBe(false);
  });
});
