import { describe, expect, it } from 'vitest';
import {
  BoundedSpeechScheduler,
  SimulatedSpeechOutput,
  SpeechEpochError,
  SpeechQueueOverflowError,
  type SpeechOutput,
  type SpeechOutputResult,
  type SpeechSegment,
} from './index.ts';

describe('BoundedSpeechScheduler', () => {
  it('records generated separately from simulated completion evidence', async () => {
    const scheduler = new BoundedSpeechScheduler(new SimulatedSpeechOutput());
    const receipt = await scheduler.speak('Hello', { kind: 'response' });

    expect(receipt).toMatchObject({ state: 'completed', evidence: 'simulated', epoch: 0 });
    expect(scheduler.history.map((item) => [item.phase, item.evidence])).toEqual([
      ['generated', 'generated'],
      ['queued', 'generated'],
      ['started', 'generated'],
      ['completed', 'simulated'],
    ]);
  });

  it('interrupts active and queued stale epochs and ignores late completion', async () => {
    let finish!: (result: SpeechOutputResult) => void;
    const output: SpeechOutput = {
      play: async (_segment, _options) =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      interrupt: async () => {},
    };
    const scheduler = new BoundedSpeechScheduler(output);
    const first = scheduler.speak('first');
    const second = scheduler.speak('second');
    await Promise.resolve();

    await scheduler.interrupt();
    expect(await first).toMatchObject({ state: 'interrupted', epoch: 0 });
    expect(await second).toMatchObject({ state: 'interrupted', epoch: 0 });

    finish({ state: 'completed', evidence: 'confirmed' });
    await Promise.resolve();
    expect(scheduler.history.filter((item) => item.phase === 'completed')).toHaveLength(0);
    expect(scheduler.epoch).toBe(1);
    await expect(scheduler.speak('late stale response', { epoch: 0 })).rejects.toBeInstanceOf(
      SpeechEpochError,
    );
  });

  it('rejects growth beyond the configured segment bound', async () => {
    const output: SpeechOutput = {
      play: async (_segment: SpeechSegment, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      interrupt: async () => {},
    };
    const scheduler = new BoundedSpeechScheduler(output, { maxQueuedSegments: 1 });
    const pending = scheduler.speak('held');
    await expect(scheduler.speak('overflow')).rejects.toBeInstanceOf(SpeechQueueOverflowError);
    await scheduler.interrupt();
    await expect(pending).resolves.toMatchObject({ state: 'interrupted' });
    expect(scheduler.history.some((item) => item.phase === 'dropped')).toBe(true);
  });

  it('bounds a provider that never settles and requests an output flush', async () => {
    const interrupted: number[] = [];
    const output: SpeechOutput = {
      play: async () => new Promise(() => {}),
      interrupt: async (epoch) => {
        interrupted.push(epoch);
      },
    };
    const scheduler = new BoundedSpeechScheduler(output, { playbackTimeoutMs: 5 });
    await expect(scheduler.speak('bounded')).resolves.toMatchObject({
      state: 'interrupted',
      evidence: 'estimated',
    });
    expect(interrupted).toEqual([0]);
    expect(scheduler.history.at(-1)).toMatchObject({
      phase: 'interrupted',
      reason: 'speech playback timed out',
    });
  });

  it('bounds retained evidence independently from queue limits', async () => {
    const scheduler = new BoundedSpeechScheduler(new SimulatedSpeechOutput(), {
      maxEvidenceEntries: 4,
    });
    await scheduler.speak('first');
    await scheduler.speak('second');
    expect(scheduler.history).toHaveLength(4);
    expect(scheduler.history.map((item) => item.text)).toEqual([
      'second',
      'second',
      'second',
      'second',
    ]);
  });
});
