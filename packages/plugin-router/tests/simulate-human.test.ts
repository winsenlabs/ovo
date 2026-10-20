import { describe, expect, it } from 'vitest';
import { exampleRoutingSnapshot } from '../src/testing.ts';
import { NIGHT, simulate, speech, trace } from './support-sim.ts';
import { deskSnapshot, DESK_ID, OFFICE } from './support-human.ts';

describe('simulateRoute: human queues', () => {
  const ask = (
    snapshot = deskSnapshot(),
    over = {},
    flags = { transferEnabled: true, humanQueueEnabled: true },
    at?: number,
  ) =>
    simulate(snapshot, { turns: [speech('zzz')], ...over }, { flags, ...(at ? { now: at } : {}) });

  it('hands to the queue and says its announcement', async () => {
    const run = await ask();
    expect(run.outcome).toMatchObject({
      status: 'human',
      completionReason: 'route:human:intent',
      line: 'A colleague will take over.',
      human: { queueKey: 'desk', queueId: DESK_ID, kind: 'managed', precheck: 'ok' },
    });
  });

  it('continues the chain to the callback when the queue is closed by its hours', async () => {
    const snapshot = deskSnapshot({ queue: { hours: OFFICE } });
    expect((await ask(snapshot)).outcome.status).toBe('human');
    const night = await ask(snapshot, {}, undefined, NIGHT);
    expect(trace(night)).toContain('fallback:human:failed(queue_closed)');
    expect(night.outcome).toMatchObject({
      status: 'callback',
      human: { queueKey: 'desk', queueId: DESK_ID, kind: 'managed', precheck: 'queue_closed' },
    });
  });

  it.each(['queue_closed', 'queue_unavailable', 'no_operators', 'queue_full'] as const)(
    'refuses with %s when the faults say so',
    async (code) => {
      const run = await ask(deskSnapshot(), { faults: { queues: { desk: code } } });
      expect(trace(run)).toContain(`fallback:human:failed(${code})`);
      expect(run.outcome.status).toBe('callback');
      expect(run.outcome.human).toMatchObject({ queueKey: 'desk', precheck: code });
    },
  );

  it('refuses queue_unavailable when human queues are assumed off, and skips the step without transfers', async () => {
    const off = await ask(deskSnapshot(), {}, { transferEnabled: true, humanQueueEnabled: false });
    expect(trace(off)).toContain('fallback:human:failed(queue_unavailable)');
    expect(off.outcome.human).toMatchObject({ precheck: 'queue_unavailable' });
    const noBegin = await ask(
      deskSnapshot(),
      {},
      { transferEnabled: false, humanQueueEnabled: true },
    );
    expect(trace(noBegin)).toContain('fallback:human:skipped(human_queue_unavailable)');
    expect(noBegin.outcome.human).toBeNull();
    expect(noBegin.outcome.status).toBe('callback');
  });
});

describe('simulateRoute: disclosure', () => {
  const router = {
    timezone: 'Asia/Kolkata',
    disclosure: [{ kind: 'recording' as const, text: 'This call is recorded.' }],
  };

  it('says the disclosure before the greeting and records it once heard, when transfers are on', async () => {
    const run = await simulate(
      exampleRoutingSnapshot(),
      {},
      {
        router,
        flags: { transferEnabled: true, humanQueueEnabled: true },
      },
    );
    expect(run.turns[0]!.say).toBe(
      'This call is recorded. Welcome to Acme. How can I help you today?',
    );
    expect(run.turns[0]!.steps).toEqual([
      { type: 'disclosure', payload: { kinds: ['recording'] } },
    ]);
  });

  it('says nothing extra without transfers, as in production', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {}, { router });
    expect(run.turns[0]!.say).toBe('Welcome to Acme. How can I help you today?');
    expect(run.turns[0]!.steps).toEqual([]);
  });
});
