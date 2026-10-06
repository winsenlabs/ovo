import { describe, expect, it, vi } from 'vitest';
import { BoundedCallEventWriter, type CallEventStore } from '../src/telemetry-event-writer.ts';

type Written = { callId: string; type: string; payload: Record<string, unknown> };

function event(callId: string, type = 'speech.completed', payload: Record<string, unknown> = {}) {
  return { workspaceId: 'workspace-1', callId, type, payload };
}

function batchStore(written: Written[], batches: number[] = []) {
  return {
    appendCallEvent: vi.fn(async () => {
      throw new Error('per-event write used although batches are supported');
    }),
    appendCallEvents: vi.fn(async (_workspaceId: string, callId: string, events: any[]) => {
      batches.push(events.length);
      for (const { type, payload } of events) written.push({ callId, type, payload });
    }),
  } satisfies CallEventStore;
}

describe('call event writer (OBS-10)', () => {
  it('writes a call in order, in batches, through the batch API when the store has one', async () => {
    const written: Written[] = [];
    const batches: number[] = [];
    const writer = new BoundedCallEventWriter(batchStore(written, batches), 500, 1_000);
    for (let index = 0; index < 120; index++)
      writer.tryEnqueue(event('call-1', 'speech.completed', { index }));
    await writer.close();
    expect(written.map((row) => row.payload.index)).toEqual([...Array(120).keys()]);
    expect(batches.every((size) => size <= 50)).toBe(true);
    expect(batches.length).toBeLessThan(10);
    expect(writer.stats()).toMatchObject({ accepted: 120, written: 120, dropped: 0, queued: 0 });
  });

  it('writes other calls while one call is slow', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const written: string[] = [];
    const writer = new BoundedCallEventWriter(
      {
        appendCallEvent: async (_workspace, callId) => {
          if (callId === 'slow') await slow;
          written.push(callId);
          return undefined as never;
        },
      },
      100,
      1_000,
    );
    writer.tryEnqueue(event('slow'));
    writer.tryEnqueue(event('fast'));
    await vi.waitFor(() => expect(written).toEqual(['fast']));
    release();
    await writer.close();
    expect(written).toEqual(['fast', 'slow']);
  });

  it('retries a transient database failure and counts the retry', async () => {
    let attempts = 0;
    const writer = new BoundedCallEventWriter(
      {
        appendCallEvent: async () => {
          attempts++;
          if (attempts < 3)
            throw Object.assign(new Error('connection terminated'), { code: '57P01' });
          return undefined as never;
        },
      },
      10,
      5_000,
    );
    writer.tryEnqueue(event('call-1'));
    await writer.close();
    expect(attempts).toBe(3);
    expect(writer.stats()).toMatchObject({ written: 1, failed: 0, retried: 2 });
  });

  it('does not retry a permanent failure', async () => {
    const append = vi.fn(async () => {
      throw new Error('Call not found');
    });
    const errors: string[] = [];
    const writer = new BoundedCallEventWriter({ appendCallEvent: append }, 10, 1_000, (error) =>
      errors.push(error.message),
    );
    writer.tryEnqueue(event('call-1'));
    await writer.close();
    expect(append).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['Call not found']);
    expect(writer.stats()).toMatchObject({ failed: 1, retried: 0 });
  });

  it('samples interim transcript revisions but keeps every final one', async () => {
    const written: Written[] = [];
    const writer = new BoundedCallEventWriter(batchStore(written), 100, 1_000);
    const revision = (isFinal: boolean, text: string) =>
      writer.tryEnqueue(event('call-1', 'transcript.revision', { isFinal, text }));
    expect(revision(false, 'he')).toBe(true);
    expect(revision(false, 'hel')).toBe(false);
    expect(revision(false, 'hell')).toBe(false);
    expect(revision(true, 'hello')).toBe(true);
    await writer.close();
    expect(written.map((row) => row.payload.text)).toEqual(['he', 'hello']);
    expect(writer.stats()).toMatchObject({ sampled: 2, dropped: 0 });
  });

  it('sheds interim revisions first when the queue is half full', () => {
    const writer = new BoundedCallEventWriter(
      { appendCallEvent: () => new Promise(() => undefined) },
      4,
      100,
    );
    expect(writer.tryEnqueue(event('call-1'))).toBe(true);
    expect(writer.tryEnqueue(event('call-1'))).toBe(true);
    const interim = event('call-2', 'transcript.revision', { isFinal: false });
    expect(writer.tryEnqueue(interim)).toBe(false);
    expect(writer.tryEnqueue(event('call-2'))).toBe(true);
    expect(writer.stats()).toMatchObject({ sampled: 1, dropped: 0, queued: 3 });
  });

  it("writes each call's evidence accounting as its telemetry.stats event", async () => {
    const written: Written[] = [];
    const writer = new BoundedCallEventWriter(batchStore(written), 3, 1_000);
    writer.tryEnqueue(event('call-1', 'transcript.revision', { isFinal: false }));
    writer.tryEnqueue(event('call-1', 'transcript.revision', { isFinal: false })); // sampled
    writer.tryEnqueue(event('call-1'));
    writer.tryEnqueue(event('call-1'));
    writer.tryEnqueue(event('call-1')); // over the cap of 3
    const counts = writer.finishCall('workspace-1', 'call-1');
    expect(counts).toEqual({ accepted: 3, dropped: 1, sampled: 1, failed: 0 });
    await writer.close();
    expect(written.at(-1)).toEqual({ callId: 'call-1', type: 'telemetry.stats', payload: counts });
    expect(writer.finishCall('workspace-1', 'call-1')).toEqual({
      accepted: 0,
      dropped: 0,
      sampled: 0,
      failed: 0,
    });
  });

  it('flushes everything queued on close and refuses events afterwards', async () => {
    const written: Written[] = [];
    const writer = new BoundedCallEventWriter(batchStore(written), 1_000, 1_000);
    for (const callId of ['a', 'b', 'c', 'd', 'e', 'f']) writer.tryEnqueue(event(callId));
    await writer.close();
    expect(written).toHaveLength(6);
    expect(writer.tryEnqueue(event('a'))).toBe(false);
    expect(writer.stats()).toMatchObject({ written: 6, dropped: 1, closed: true });
  });
});
