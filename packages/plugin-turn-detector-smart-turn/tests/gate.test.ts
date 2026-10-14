import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeTurnDetector } from '@winsendotai/ovo-conformance';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { VoiceEvent } from '@winsendotai/ovo-contracts';
import { createModelTurnDetector } from '@winsendotai/ovo-plugin-turns';
import { SMART_TURN, SmartTurnModel } from '../src/index.ts';

/** Smart Turn behind plugin-turns' model gate (the model file comes from OVO_TURN_MODELS_DIR). */
const path = join(process.env.OVO_TURN_MODELS_DIR ?? '', 'smart-turn', SMART_TURN.file);
const model =
  process.env.OVO_TURN_MODELS_DIR && existsSync(path)
    ? await SmartTurnModel.load({ modelPath: path })
    : undefined;

if (model) {
  // With no audio from the host every turn is read by the rules alone: the detector stays a
  // conforming turn detector (turn@1) whatever the host passes.
  describeTurnDetector('Smart Turn gate, no audio', () => createModelTurnDetector({}, model));
}

describe.skipIf(!model)('Smart Turn behind the model gate', () => {
  it('reads the caller audio when the rules end a turn, and ends or holds it on the reading', async () => {
    const clock = new FakeClock();
    const controller = createModelTurnDetector({ model: { holdMs: 1000 } }, model!).create({
      clock,
      vad: true,
      language: 'en-IN',
      mode: 'agent',
      stt: {
        languages: ['en'],
        interim: true,
        wordTimestamps: false,
        forceEndpoint: true,
        turnSignals: [],
      },
    });
    const stops: number[] = [];
    controller.on((d) => {
      if (d.type === 'turn.stopped') stops.push(clock.now());
    });
    const send = (event: Record<string, unknown>) =>
      controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
    // 1.5 s of a voiced 8 kHz tone, then silence, 20 ms frames.
    for (let t = 0; t < 3000; t += 20) {
      const frame = Int16Array.from({ length: 160 }, (_, n) =>
        t < 1500 ? Math.round(6000 * Math.sin((2 * Math.PI * 180 * (t * 8 + n)) / 8000)) : 0,
      );
      controller.audio(frame, 8000);
      if (t === 0) send({ type: 'vad.start' });
      if (t === 1700) send({ type: 'vad.stop' });
      if (t === 2000) {
        send({
          type: 'stt',
          event: {
            type: 'transcript',
            segment: {
              segmentId: '0',
              revision: 1,
              text: 'We are going to Vienna.',
              stability: 'final',
            },
          },
        });
        send({ type: 'stt', event: { type: 'end-of-turn' } });
      }
      clock.advance(20);
      await controller.settled();
    }
    clock.advance(2000);
    await controller.settled();
    expect(controller.stats.predictions).toHaveLength(1);
    const [probability] = controller.stats.predictions;
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
    expect(stops).toHaveLength(1);
    // Read finished: ended with the rules; read unfinished: ended once the 1 s hold ran out.
    expect(controller.stats.held.length).toBe(probability! >= 0.5 ? 0 : 1);
  });
});
