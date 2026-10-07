import { describe, expect, it } from 'vitest';
import type { SpeechOutput } from '@winsendotai/ovo-contracts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

/** An output whose synthesis and playout the test finishes line by line, on a manual clock. */
function manualOutput(reportsSent = true) {
  const synthesised = new Map<string, () => void>();
  const finished = new Map<string, () => void>();
  const wait = (map: Map<string, () => void>, text: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      map.set(text, resolve);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  const output: SpeechOutput = {
    // Preparing lets the scheduler play lines ahead, so a line is sent while the one before plays.
    async prepare() {},
    async play(segment, { signal, report }) {
      await wait(synthesised, segment.text, signal);
      if (signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
      if (reportsSent) report?.('sent', 'estimated');
      await wait(finished, segment.text, signal);
      return signal.aborted
        ? { state: 'interrupted', evidence: 'estimated' }
        : { state: 'completed', evidence: 'confirmed' };
    },
    async interrupt() {},
  };
  const clock = { now: 0 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const scheduler = new BoundedSpeechScheduler(output, {}, () => clock.now);
  scheduler.configurePipeline(2);
  /** At `ms` on the manual clock, `step` on `text`. */
  const at = async (ms: number, map: Map<string, () => void>, text: string) => {
    clock.now = ms;
    map.get(text)!();
    await tick();
  };
  return { scheduler, synthesised, finished, clock, tick, at };
}

describe('speech receipts report how long each line played (playedMs)', () => {
  it('times a line sent ahead from when the line before it finished playing', async () => {
    const out = manualOutput();
    const [first, second] = ['Thank you for calling.', 'Goodbye.'].map((text) =>
      out.scheduler.speak(text),
    );
    await out.tick();
    await out.at(0, out.synthesised, 'Thank you for calling.');
    // The second line reaches the carrier while the first still plays: it waits behind it.
    await out.at(100, out.synthesised, 'Goodbye.');
    await out.at(1800, out.finished, 'Thank you for calling.');
    await out.at(2500, out.finished, 'Goodbye.');
    expect(await first).toMatchObject({ state: 'completed', playedMs: 1800 });
    expect(await second).toMatchObject({ state: 'completed', playedMs: 700 });
  });

  it('a goodbye cut in its last words reports nearly all of it played; the next line none', async () => {
    const out = manualOutput();
    const [goodbye, after] = ['Thanks for calling, goodbye.', 'Take care.'].map((text) =>
      out.scheduler.speak(text),
    );
    await out.tick();
    await out.at(0, out.synthesised, 'Thanks for calling, goodbye.');
    await out.at(50, out.synthesised, 'Take care.');
    out.clock.now = 1900;
    await out.scheduler.beginEpoch();
    expect(await goodbye).toMatchObject({ state: 'interrupted', playedMs: 1900 });
    expect(await after).toMatchObject({ state: 'interrupted', playedMs: 0 });
  });

  it('a line cut before its audio reached the carrier played for 0 ms', async () => {
    const out = manualOutput();
    const [heard, unsent] = ['Hello.', 'How are you?'].map((text) => out.scheduler.speak(text));
    await out.tick();
    await out.at(0, out.synthesised, 'Hello.');
    await out.at(600, out.finished, 'Hello.');
    out.clock.now = 900;
    await out.scheduler.beginEpoch();
    expect(await heard).toMatchObject({ playedMs: 600 });
    expect(await unsent).toMatchObject({ state: 'interrupted', playedMs: 0 });
  });

  it('is absent while the output never reports audio reaching the carrier', async () => {
    const out = manualOutput(false);
    const line = out.scheduler.speak('Hello.');
    await out.tick();
    await out.at(0, out.synthesised, 'Hello.');
    await out.at(600, out.finished, 'Hello.');
    expect(await line).not.toHaveProperty('playedMs');
  });
});
