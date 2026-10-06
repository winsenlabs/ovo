import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SynthesisInput } from '@winsendotai/ovo-contracts';
import { WorkerSpeechCacheRuntime } from '../src/speech-cache-runtime.ts';
import { composeCacheOutput, fixtureRelease, RecordingTts } from './speech-cache-harness.ts';

/** One second of mu-law: fifty 20 ms carrier frames. */
class OneSecondTts extends RecordingTts {
  override async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    this.calls.push({ path: 'synthesize', text: input.text, sessionId: input.sessionId });
    yield new Uint8Array(8_000).fill(7);
  }
}

afterEach(() => vi.useRealTimers());

describe('barge-in over a cached clip (critic)', () => {
  it('stops a pinned clip within one frame of the barge-in, then clears the carrier', async () => {
    vi.useFakeTimers({ now: 0 });
    const tts = new OneSecondTts();
    const runtime = new WorkerSpeechCacheRuntime();
    const release = fixtureRelease({ speechCache: { enabled: true }, clarification: 'Sorry?' });
    const session = await composeCacheOutput({ release, cache: runtime.cache, tts, frameMs: 20 });
    const first = session.play('Sorry?');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toMatchObject({ state: 'completed' });
    expect(runtime.cache.pinned.stats.entries).toBe(1);
    const framesBefore = session.audio.length;
    // The second time the clip comes from the pinned tier, at carrier pace.
    const bargeIn = new AbortController();
    const startedAt = Date.now();
    const cached = session.play('Sorry?', 'response', bargeIn.signal);
    await vi.advanceTimersByTimeAsync(200);
    bargeIn.abort(new DOMException('caller spoke', 'AbortError'));
    const abortedAt = Date.now();
    const interrupt = session.output.interrupt(2);
    let settledAt = 0;
    void cached.then(() => (settledAt = Date.now()));
    await vi.advanceTimersByTimeAsync(20);
    expect(await cached).toMatchObject({ state: 'interrupted' });
    await interrupt;
    expect(settledAt - abortedAt).toBeLessThanOrEqual(20);
    // Ten frames went out in 200 ms; nothing after the barge-in, and the carrier was cleared.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.audio.length - framesBefore).toBe((abortedAt - startedAt) / 20);
    expect(session.clears.at(-1)).toBeGreaterThanOrEqual(abortedAt);
    expect(tts.calls).toHaveLength(1);
    await session.dispose();
    await runtime.close();
  });
});
