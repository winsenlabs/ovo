import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { SMART_TURN, SmartTurnModel } from '../src/index.ts';
import { REFERENCE, synth } from './synth.ts';

/** The model is fetched at build time (scripts/fetch-model.mjs), never committed. */
const path = join(process.env.OVO_TURN_MODELS_DIR ?? '', 'smart-turn', SMART_TURN.file);
const present = !!process.env.OVO_TURN_MODELS_DIR && existsSync(path);

describe.skipIf(!present)('Smart Turn v3.2 (OVO_TURN_MODELS_DIR)', () => {
  it('scores the reference signal as onnxruntime-python does', async () => {
    const model = await SmartTurnModel.load({ modelPath: path });
    try {
      expect(await model.predict({ audio: synth(), text: '', language: 'en' })).toBeCloseTo(
        REFERENCE.probability,
        3,
      );
      expect(model.threshold('hi-IN')).toBe(0.5);
      expect(model.threshold('ta')).toBeUndefined();
      await expect(model.predict({ text: 'hello', language: 'en' })).rejects.toThrow(/audio/);
    } finally {
      await model.dispose();
    }
  });

  it('reads off the event loop: a reading never stalls the other calls in the process', async () => {
    const model = await SmartTurnModel.load({ modelPath: path });
    const delay = monitorEventLoopDelay({ resolution: 1 });
    try {
      const audio = synth();
      // Warm up (the first run allocates the session's buffers).
      await model.predict({ audio, text: '', language: 'en' });
      delay.enable();
      for (let i = 0; i < 10; i++) await model.predict({ audio, text: '', language: 'en' });
      delay.disable();
      // Each reading is ~65 ms of CPU on the mini (~26 ms of it the JS features); on the main
      // thread the loop stalled for all of it (max 84 ms). Here only the 256 KB copy is left.
      expect(Math.min(...model.timings)).toBeGreaterThan(5);
      expect(delay.max / 1e6).toBeLessThan(25);
    } finally {
      delay.disable();
      await model.dispose();
    }
  });

  it('takes overlapping readings from many calls, and turns away more than maxPending', async () => {
    const model = await SmartTurnModel.load({ modelPath: path, maxPending: 3 });
    try {
      const turns = [synth(), synth().map((x) => x >> 2), synth().subarray(0, 32_000)];
      const read = (audio: Int16Array) => model.predict({ audio, text: '', language: 'en' });
      const inTurn: number[] = [];
      for (const audio of turns) inTurn.push(await read(audio));
      const atOnce = turns.map(read);
      // A fourth while three wait: the gate ends that turn as the rules did.
      await expect(read(turns[0]!)).rejects.toThrow(/waiting/);
      expect(await Promise.all(atOnce)).toEqual(inTurn);
    } finally {
      await model.dispose();
    }
    // Disposed: every reading fails at once.
    await expect(model.predict({ audio: synth(), text: '', language: 'en' })).rejects.toThrow(
      /disposed/,
    );
  });

  it('fails to load, rather than hang, when the model file is missing', async () => {
    await expect(SmartTurnModel.load({ modelPath: `${path}.missing` })).rejects.toThrow();
  });
});
