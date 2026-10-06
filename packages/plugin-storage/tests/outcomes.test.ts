import { describe, expect, it, vi } from 'vitest';
import {
  CALL_OUTCOME_MAX_VARIABLES,
  MemoryCallOutcomeStore,
  QueuedSessionEventSink,
  type CallOutcomeStore,
} from '../src/outcomes/index.ts';
import { COLLECTIONS_CALL, event, expectCollectionsOutcome } from './outcomes-fixture.ts';

describe('call outcomes in memory (AGT-8)', () => {
  it('folds the events of a call into its outcome', async () => {
    await expectCollectionsOutcome(new MemoryCallOutcomeStore(), 'ws-memory');
  });

  it('bounds captured variables and keeps the newest value per key', async () => {
    const store = new MemoryCallOutcomeStore();
    const variables = Object.fromEntries(
      Array.from({ length: CALL_OUTCOME_MAX_VARIABLES + 5 }, (_, index) => [`k${index}`, index]),
    );
    await store.append('ws', 'call', [
      event('variables.captured', { variables }),
      event('variables.captured', { variables: { k0: 'updated' } }),
    ]);
    const outcome = (await store.get('ws', 'call'))!;
    expect(Object.keys(outcome.variables)).toHaveLength(CALL_OUTCOME_MAX_VARIABLES);
    expect(outcome.variables.k0).toBe('updated');
  });
});

describe('QueuedSessionEventSink', () => {
  it('returns at once, writes in order and reports malformed events without throwing', async () => {
    const store = new MemoryCallOutcomeStore();
    const errors: Error[] = [];
    const sink = new QueuedSessionEventSink(
      store,
      { workspaceId: 'ws', callId: 'call' },
      { onError: (error) => errors.push(error) },
    );
    for (const [type, payload] of COLLECTIONS_CALL) await sink.append(type, payload);
    await sink.append('turn.route', { tier: 'jev' });
    await sink.flush();
    expect(errors).toHaveLength(1);
    expect(sink.stats()).toMatchObject({
      accepted: COLLECTIONS_CALL.length,
      written: COLLECTIONS_CALL.length,
      rejected: 1,
      queued: 0,
    });
    const page = await store.listEvents('ws', 'call', 100);
    expect(page.items.map((item) => item.type)).toEqual(COLLECTIONS_CALL.map(([type]) => type));
    await sink.append('disposition', { disposition: 'late' });
    expect(sink.stats().dropped).toBe(1);
  });

  it('retries a failed write with the same ids, then drops it without failing the call', async () => {
    const append = vi
      .fn<CallOutcomeStore['append']>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(1);
    const sink = new QueuedSessionEventSink(
      { append },
      { workspaceId: 'ws', callId: 'call' },
      { retryDelayMs: 1 },
    );
    await sink.append('disposition', { disposition: 'callback' });
    await sink.flush();
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0]![2]).toEqual(append.mock.calls[1]![2]);
    expect(sink.stats()).toMatchObject({ written: 1, failedWrites: 1, dropped: 0 });

    const down = new QueuedSessionEventSink(
      { append: vi.fn().mockRejectedValue(new Error('down')) },
      { workspaceId: 'ws', callId: 'call' },
      { retryDelayMs: 1, attempts: 2 },
    );
    await down.append('disposition', { disposition: 'callback' });
    await down.flush();
    expect(down.stats()).toMatchObject({ written: 0, failedWrites: 2, dropped: 1 });
  });

  it('bounds the queue and the flush', async () => {
    const sink = new QueuedSessionEventSink(
      { append: () => new Promise(() => undefined) },
      { workspaceId: 'ws', callId: 'call' },
      { maxQueued: 2, flushTimeoutMs: 100 },
    );
    for (let index = 0; index < 4; index += 1)
      await sink.append('disposition', { disposition: `d${index}` });
    expect(sink.stats().dropped).toBe(2);
    await sink.flush();
    // The queued event is dropped at the deadline; the in-flight write never settled and nothing
    // waits on it any longer.
    expect(sink.stats()).toMatchObject({ dropped: 3, queued: 1 });
  });
});
