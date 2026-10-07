import { describe, expect, it } from 'vitest';
import type { SynthesisInput } from '@winsendotai/ovo-contracts';
import { BoundedSpeechScheduler } from '../../../packages/plugin-voice/src/scheduler.ts';
import { WorkerSpeechCacheRuntime } from '../src/speech-cache-runtime.ts';
import {
  composeCacheOutput,
  deferred,
  fixtureRelease,
  RecordingTts,
} from './speech-cache-harness.ts';

/** A provider whose audio waits on `gate` and stops at once on abort, as ElevenLabs does. */
class GatedTts extends RecordingTts {
  gated?: Promise<void>;

  override async *synthesize(input: SynthesisInput): AsyncIterable<Uint8Array> {
    this.calls.push({ path: 'synthesize', text: input.text, sessionId: input.sessionId });
    if (this.gated) {
      const aborted = new Promise<void>((resolve) =>
        input.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await Promise.race([this.gated, aborted]);
    }
    input.signal.throwIfAborted();
    yield new Uint8Array(160).fill(9);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Wave 6 review: with the speech cache on (as for CreditMantri) the session's output keys a line's
 * send state by segment. A line taken back for the caller (P1) and released in the same tick, as
 * a muted turn does, was replayed onto the old play's aborted state: no audio reached the carrier
 * and the behaviour got an 'interrupted' receipt for a line nobody barged in on.
 */
describe('a held line over the session speech output (P1 review)', () => {
  it('plays a line taken back and released in the same tick, once', async () => {
    const tts = new GatedTts();
    const runtime = new WorkerSpeechCacheRuntime();
    const release = fixtureRelease({ speechCache: { enabled: true } });
    const session = await composeCacheOutput({ release, cache: runtime.cache, tts });
    const speech = new BoundedSpeechScheduler(session.output);
    speech.configurePipeline(2);
    // The opening reached the carrier, so the output is known to report 'sent'.
    await expect(speech.speak('Hello.')).resolves.toMatchObject({ state: 'completed' });
    const framesBefore = session.audio.length;

    const gate = deferred();
    tts.gated = gate.promise;
    const reply = speech.speak('Your EMI is due tomorrow.');
    await tick();
    expect(session.audio.length).toBe(framesBefore);
    speech.hold();
    speech.release();
    tts.gated = undefined;
    gate.resolve();

    await expect(reply).resolves.toMatchObject({ state: 'completed' });
    expect(session.audio.length).toBeGreaterThan(framesBefore);
    expect(
      speech.history
        .filter((entry) => entry.text === 'Your EMI is due tomorrow.')
        .map((entry) => entry.phase),
    ).not.toContain('interrupted');
    await speech.dispose();
    await session.dispose();
    await runtime.close();
  });
});
