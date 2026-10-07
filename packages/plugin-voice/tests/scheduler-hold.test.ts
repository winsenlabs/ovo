import { describe, expect, it } from 'vitest';
import type { SpeechOutput, SpeechSegment } from '@winsendotai/ovo-contracts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

/** An output whose synthesis and playout the test finishes line by line. */
function manualOutput() {
  const synthesised = new Map<string, () => void>();
  const finished = new Map<string, () => void>();
  const prepared: string[] = [];
  const sent: string[] = [];
  const wait = (map: Map<string, () => void>, text: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      map.set(text, resolve);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  const output: SpeechOutput = {
    async prepare(segment: SpeechSegment) {
      prepared.push(segment.text);
    },
    async play(segment, { signal, report }) {
      await wait(synthesised, segment.text, signal);
      if (signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
      sent.push(segment.text);
      report?.('sent', 'estimated');
      await wait(finished, segment.text, signal);
      return signal.aborted
        ? { state: 'interrupted', evidence: 'estimated' }
        : { state: 'completed', evidence: 'confirmed' };
    },
    async interrupt() {},
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { output, prepared, sent, synthesised, finished, tick };
}

describe('BoundedSpeechScheduler.hold (P1)', () => {
  it('lets audio already sent play on, takes back the line still synthesising, keeps the order', async () => {
    const out = manualOutput();
    const scheduler = new BoundedSpeechScheduler(out.output);
    scheduler.configurePipeline(2);
    const receipts = ['A.', 'B.', 'C.'].map((text) => scheduler.speak(text));
    await out.tick();
    out.synthesised.get('A.')!();
    await out.tick();
    expect(out.sent).toEqual(['A.']);

    scheduler.hold();
    await out.tick();
    // B was synthesising: taken back. C never started. A is on the carrier and plays on.
    out.finished.get('A.')!();
    await out.tick();
    expect(out.sent).toEqual(['A.']);
    expect(scheduler.pendingCount).toBe(2);
    // Held lines are prepared meanwhile, so the release plays without a synthesis wait.
    expect(out.prepared.filter((text) => text === 'B.').length).toBeGreaterThan(1);

    scheduler.release();
    await out.tick();
    out.synthesised.get('B.')!();
    out.synthesised.get('C.')!();
    await out.tick();
    out.finished.get('B.')!();
    out.finished.get('C.')!();
    const settled = await Promise.all(receipts);
    expect(out.sent).toEqual(['A.', 'B.', 'C.']);
    expect(settled.map((receipt) => receipt.state)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(
      scheduler.history.filter((entry) => entry.phase === 'interrupted').map((e) => e.text),
    ).toEqual([]);
  });

  it('prepares held lines in speaking order, after a line taken back has returned', async () => {
    const out = manualOutput();
    const scheduler = new BoundedSpeechScheduler(out.output);
    scheduler.configurePipeline(2);
    for (const text of ['A.', 'B.']) void scheduler.speak(text);
    await out.tick();
    out.synthesised.get('A.')!();
    await out.tick();
    // A is on the carrier and B is synthesising; nothing waits in the queue.
    scheduler.hold();
    void scheduler.speak('C.');
    await out.tick();
    // The session's cached output sends in the order lines were prepared: B before C.
    expect(out.prepared).toEqual(['A.', 'B.', 'B.', 'C.']);
    await scheduler.dispose();
  });

  it('flushes held lines with their epoch', async () => {
    const out = manualOutput();
    const scheduler = new BoundedSpeechScheduler(out.output);
    scheduler.configurePipeline(1);
    scheduler.hold();
    const held = scheduler.speak('Stale answer.');
    await out.tick();
    await scheduler.beginEpoch();
    expect(await held).toMatchObject({ state: 'interrupted' });
    scheduler.release();
    const next = scheduler.speak('Merged answer.');
    await out.tick();
    out.synthesised.get('Merged answer.')!();
    await out.tick();
    out.finished.get('Merged answer.')!();
    expect(await next).toMatchObject({ state: 'completed' });
    expect(out.sent).toEqual(['Merged answer.']);
  });

  it('settled() waits only for lines that are playing, not held ones', async () => {
    const out = manualOutput();
    const scheduler = new BoundedSpeechScheduler(out.output);
    scheduler.configurePipeline(2);
    void scheduler.speak('Playing.');
    void scheduler.speak('Waiting.');
    await out.tick();
    out.synthesised.get('Playing.')!();
    await out.tick();
    scheduler.hold();
    let settled = false;
    void scheduler.settled().then(() => (settled = true));
    await out.tick();
    expect(settled).toBe(false);
    out.finished.get('Playing.')!();
    await out.tick();
    expect(settled).toBe(true);
    expect(out.sent).toEqual(['Playing.']);
    await scheduler.dispose();
  });
});
