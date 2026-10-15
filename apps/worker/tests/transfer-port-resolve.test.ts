import { Cap } from '@winsendotai/ovo-contracts';
import { compose } from '@winsendotai/ovo-runtime';
import { describe, expect, it } from 'vitest';
import { agentTransferService } from '../src/transfer-port.ts';
import { CLAIM, POOL, transferPolicy } from './transfer-fixtures.ts';
import { ask, OTHER_POOL, port, signal, targets } from './transfer-port-fixture.ts';

describe('the agent transfer port: resolution and claims (transfer design 7.2, 7.4)', () => {
  it('claims a member of the target pool, leaving out releases the call already left', async () => {
    const h = port();
    const result = await h.port.request(ask('billing'), signal());
    // release-b answered segment 1: under returnToPrevious refuse only b2 remains.
    expect(h.claims.claim).toHaveBeenCalledWith([
      [expect.objectContaining({ memberId: 'b2', releaseId: 'release-b2' })],
    ]);
    expect(h.begun[0]).toEqual({
      kind: 'agent',
      reason: 'transfer',
      agentId: 'agent-b2',
      releaseId: 'release-b2',
      variables: { ovo_route_language: 'en', ovo_route_intent: 'sales' },
      route: { path: ['intent'], poolId: OTHER_POOL, memberId: 'b2', claimId: CLAIM },
      transfer: { source: 'llm', key: 'billing', reason: 'refund', summary: 'Double charge' },
    });
    expect(h.controller.beginWith).toHaveBeenCalledWith(h.begun[0], expect.anything(), {
      target: targets[0],
      claimed: true,
    });
    expect(result).toEqual({
      ok: true,
      transferId: 'handoff-1',
      announcement: "I'm transferring your call now. Please stay on the line.",
      queued: false,
    });
    const [type, payload] = h.recorded[0]!;
    expect(type).toBe('transfer.requested');
    expect(payload).toEqual({
      ...{ transfer: 1, fromSegment: 2, source: 'llm', kind: 'agent', key: 'billing' },
      ...{ confirm: 'never', result: 'accepted', queued: false },
    });
    // Ids, codes and keys only: never the LLM's words.
    expect(JSON.stringify([h.recorded, h.logs])).not.toMatch(/Double charge|refund/);
  });

  it('refuses a pool the call has already been through (ping-pong), and allows it when set', async () => {
    const back = transferPolicy({
      targets: [
        {
          key: 'back',
          description: 'Back',
          destination: { kind: 'pool', poolId: OTHER_POOL, language: 'caller', skills: [] },
        },
      ],
    });
    const refuse = port({ policy: back });
    refuse.memory.started({
      index: 3,
      role: 'agent',
      agentId: 'agent-b2',
      releaseId: 'release-b2',
      startedAt: 3,
    });
    expect(await refuse.port.request(ask('back'), signal())).toEqual({
      ok: false,
      reason: 'ping_pong',
    });
    const allow = port({
      policy: { ...back, limits: { ...back.limits, returnToPrevious: 'allow' } },
    });
    expect(await allow.port.request(ask('back'), signal())).toMatchObject({ ok: true });
  });

  it("confirms a same-pool transfer on the caller's yes, excluding this member", async () => {
    const h = port();
    expect(await h.port.request(ask('senior', true), signal())).toMatchObject({ ok: true });
    expect(h.claims.claim).toHaveBeenCalledWith([[expect.objectContaining({ memberId: 'a2' })]]);
    expect(h.recorded[0]![1]).toMatchObject({ confirm: 'asked', result: 'accepted' });
  });

  it('queues on a full pool when the hold waits for capacity, with the queue line', async () => {
    const policy = transferPolicy({
      targets,
      hold: {
        steps: [{ kind: 'silence', seconds: 3 }],
        loopFrom: 0,
        maxSeconds: 60,
        waitForCapacity: true,
        onTimeout: [{ kind: 'default' }],
      },
      queueAnnouncement: { en: 'Everyone is busy; please hold.' },
    });
    const h = port({
      policy,
      claim: { kind: 'full' },
      begin: { ok: true, handoffId: 'handoff-1', state: 'queued' },
    });
    expect(await h.port.request(ask('billing'), signal())).toEqual({
      ok: true,
      transferId: 'handoff-1',
      announcement: 'Everyone is busy; please hold.',
      queued: true,
    });
    expect(h.begun[0]).toMatchObject({
      kind: 'queue',
      poolId: OTHER_POOL,
      tiers: [[expect.objectContaining({ memberId: 'b2' })]],
    });
  });

  it('fails open when claim storage is down: the transfer proceeds unclaimed', async () => {
    const h = port({
      claim: {
        kind: 'unclaimed',
        candidate: {
          poolId: OTHER_POOL,
          memberId: 'b2',
          agentId: 'agent-b2',
          releaseId: 'release-b2',
        },
        reason: 'claims_unavailable',
      },
    });
    expect(await h.port.request(ask('billing'), signal())).toMatchObject({ ok: true });
    expect(h.begun[0]).toMatchObject({ route: { memberId: 'b2' } });
    expect(h.begun[0]).not.toHaveProperty('route.claimId');
  });

  it("announces with the target's line, the agent's own, or the built-in in its language", async () => {
    expect(
      await port({ line: 'Hold on, transferring.' }).port.request(ask('language'), signal()),
    ).toMatchObject({
      announcement: 'Hold on, transferring.',
    });
    expect(await port({ language: 'hi-IN' }).port.request(ask('language'), signal())).toMatchObject(
      {
        announcement: 'आपकी कॉल ट्रांसफर की जा रही है। कृपया लाइन पर बने रहें।',
      },
    );
    const point = transferPolicy({ targets, announcement: { en: 'Let me get the right team.' } });
    expect(await port({ policy: point }).port.request(ask('language'), signal())).toMatchObject({
      announcement: 'Let me get the right team.',
    });
  });

  it("cancel abandons the transfer, claims this segment's member again, and says so", async () => {
    const h = port();
    await h.port.cancel('unknown');
    expect(h.controller.abandon).not.toHaveBeenCalled();
    await h.port.cancel('handoff-1');
    expect(h.controller.abandon).toHaveBeenCalledWith('handoff-1');
    expect(h.claims.claim).toHaveBeenCalledWith([
      [{ poolId: POOL, memberId: 'a', agentId: 'agent-a', releaseId: 'release-a' }],
    ]);
    expect(h.recorded).toEqual([
      [
        'transfer.completed',
        expect.objectContaining({ transfer: 2, outcome: 'failed', reason: 'cancelled', holdMs: 0 }),
      ],
    ]);
    h.port.commit('handoff-1');
    expect(h.controller.commit).toHaveBeenCalledWith('handoff-1');
  });

  it('hands the segment what it inherited, and is offered as ovo.agent-transfer', async () => {
    const h = port();
    expect(h.port.inbound).toMatchObject({ kind: 'transfer' });
    expect(h.controller.handover).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ variables: {} }),
    );
    const service = agentTransferService(h.port);
    expect(service.manifest.provides).toEqual([Cap.agentTransfer]);
    const composition = await compose([{ id: service.manifest.id }], [service], {
      scope: 'session',
    });
    expect(composition.ctx.get(Cap.agentTransfer)).toBe(h.port);
    await composition.dispose();
  });
});
