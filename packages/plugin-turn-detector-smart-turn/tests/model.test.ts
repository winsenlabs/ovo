import { join } from 'node:path';
import { existsSync } from 'node:fs';
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
});
