import { describe, expect, it } from 'vitest';
import { BoundedByteCache } from '@winsendotai/ovo-plugin-cache';
import type { SpeechSegment } from '../../contracts/src/index.ts';
import { CachedSpeechOutput, type NormalizedTts } from '../src/index.ts';

function fixture() {
  const cache = new BoundedByteCache();
  let calls = 0;
  let canceled = 0;
  const tts: NormalizedTts = {
    synthesize: (_request, { signal }) => {
      calls++;
      if (calls === 1)
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              canceled++;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      return Promise.resolve({
        audio: Uint8Array.of(1, 2),
        usage: {
          provider: 'fixture',
          requestId: `synthesis-${calls}`,
          quantity: '1',
          unit: 'characters',
          state: 'reconciled',
        },
      });
    },
  };
  const output = new CachedSpeechOutput(
    {
      workspaceId: 'workspace',
      provider: 'fixture',
      bindingVersion: '1',
      model: 'model',
      voice: 'voice',
      locale: 'en-IN',
      codec: 'pcm16',
      sampleRate: 8_000,
      pronunciation: '1',
      prosodyRevision: '1',
      optionsRevision: '1',
      approvedPhrases: [{ text: 'Please wait.', purpose: 'static-phrase' }],
    },
    {
      cache,
      tts,
      player: {
        play: async () => ({ state: 'completed', evidence: 'simulated', usage: [] }),
        interrupt: async () => undefined,
      },
    },
  );
  const segment: SpeechSegment = {
    id: 'prepared',
    text: 'Please wait.',
    kind: 'acknowledgment',
    epoch: 0,
    generatedAt: 1,
  };
  return { output, segment, cache, calls: () => calls, canceled: () => canceled };
}

describe('cached output preparation cleanup', () => {
  it('abandons a prepared segment aborted before play, including scheduler disposal', async () => {
    const { output, segment, calls } = fixture();
    const controller = new AbortController();
    await output.prepare(segment, controller.signal);
    controller.abort(new DOMException('scheduler disposed', 'AbortError'));
    await expect(output.play(segment, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(output.play(segment, { signal: new AbortController().signal })).resolves.toEqual({
      state: 'completed',
      evidence: 'simulated',
    });
    expect(calls()).toBe(2);
  });

  it('cleans up a prepared rejection consumed by play so the segment can be retried', async () => {
    const { output, segment, calls } = fixture();
    const controller = new AbortController();
    await output.prepare(segment, controller.signal);
    const playing = output.play(segment, { signal: controller.signal });
    controller.abort();
    await expect(playing).rejects.toMatchObject({ name: 'AbortError' });
    await expect(output.play(segment, { signal: new AbortController().signal })).resolves.toEqual({
      state: 'completed',
      evidence: 'simulated',
    });
    expect(calls()).toBe(2);
  });

  it('abandons and cancels pending preparation when its epoch is interrupted', async () => {
    const { output, segment, calls, canceled, cache } = fixture();
    await output.prepare(segment, new AbortController().signal);
    await output.interrupt(segment.epoch + 1);
    expect(canceled()).toBe(0);
    await output.interrupt(segment.epoch);
    expect(canceled()).toBe(1);
    await expect.poll(() => cache.stats.pending).toBe(0);
    await expect(output.play(segment, { signal: new AbortController().signal })).resolves.toEqual({
      state: 'completed',
      evidence: 'simulated',
    });
    expect(calls()).toBe(2);
  });

  it('abandons preparation in finally when play receives an independently aborted signal', async () => {
    const { output, segment, canceled, cache } = fixture();
    await output.prepare(segment, new AbortController().signal);
    const controller = new AbortController();
    controller.abort();
    await expect(output.play(segment, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(canceled()).toBe(1);
    await expect.poll(() => cache.stats.pending).toBe(0);
    await expect(output.play(segment, { signal: new AbortController().signal })).resolves.toEqual({
      state: 'completed',
      evidence: 'simulated',
    });
  });
});
