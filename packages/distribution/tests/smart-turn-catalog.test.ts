import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { Cap, type TurnDetectorFactory, type VoiceEvent } from '@winsendotai/ovo-contracts';
import { turnShadowTelemetry } from '@winsendotai/ovo-plugin-turns';
import { compose } from '@winsendotai/ovo-runtime';
import { FIRST_PARTY } from '../src/catalog.ts';
import { loadDistribution } from '../src/load.ts';
import { SMART_TURN_DETECTOR_ID, smartTurnModule } from '../src/smart-turn.ts';

const modelsDir = process.env.OVO_TURN_MODELS_DIR;
const haveModel =
  !!modelsDir && existsSync(join(modelsDir, 'smart-turn', 'smart-turn-v3.2-cpu.onnx'));
const stt = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};

async function detector(
  env: Record<string, string | undefined>,
  config: Record<string, unknown> = {},
) {
  const [plugin] = (await smartTurnModule(env)).plugins;
  const graph = await compose([{ id: SMART_TURN_DETECTOR_ID, config }], [plugin!], {
    scope: 'session',
  });
  const factory = graph.get(Cap.turnDetector) as TurnDetectorFactory;
  const clock = new FakeClock();
  const controller = factory.create({ clock, vad: true, language: 'en-IN', mode: 'agent', stt });
  return { graph, controller, clock };
}

afterEach(() => turnShadowTelemetry.reset());

describe('Smart Turn catalog entry', () => {
  it('is a session package the api and gateway distributions install', async () => {
    const entry = FIRST_PARTY.find(
      (item) => item.package === '@winsendotai/ovo-plugin-turn-detector-smart-turn',
    );
    expect(entry?.roles).toEqual(['session']);
    for (const role of ['api', 'gateway'] as const) {
      const loaded = await loadDistribution({ role, profile: 'compose', env: {} });
      expect(loaded.catalog.map((plugin) => plugin.manifest.id)).toContain(SMART_TURN_DETECTOR_ID);
    }
  });

  it('gives an agent the rules, not a broken call, when OVO_TURN_MODELS_DIR is unset or empty', async () => {
    for (const env of [{}, { OVO_TURN_MODELS_DIR: '/nonexistent/models' }]) {
      const { graph, controller } = await detector(env, { mode: 'active' });
      expect(controller.audio).toBeUndefined();
      controller.dispose();
      await graph.dispose();
    }
    expect(turnShadowTelemetry.snapshot()).toMatchObject({ sessionFallbacks: 2 });
  });
});

describe.skipIf(!haveModel)('Smart Turn through the distribution (real model)', () => {
  it('reads the caller audio in shadow mode and reports it, ending turns as the rules do', async () => {
    const { graph, controller, clock } = await detector({ OVO_TURN_MODELS_DIR: modelsDir! });
    try {
      expect(controller.audio).toBeTypeOf('function');
      const stops: number[] = [];
      controller.on((decision) => {
        if (decision.type === 'turn.stopped') stops.push(clock.now());
      });
      const send = (event: Record<string, unknown>) =>
        controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
      for (let t = 0; t < 3000; t += 20) {
        controller.audio!(
          Int16Array.from({ length: 160 }, (_, n) =>
            t < 1500 ? Math.round(6000 * Math.sin((2 * Math.PI * 180 * (t * 8 + n)) / 8000)) : 0,
          ),
          8000,
        );
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
                text: 'We are going to Vienna today.',
                stability: 'final',
              },
            },
          });
          send({ type: 'stt', event: { type: 'end-of-turn' } });
        }
        clock.advance(20);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      clock.advance(4000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      clock.advance(4000);
      expect(stops).toHaveLength(1);
      expect(turnShadowTelemetry.snapshot().turns).toBe(1);
    } finally {
      controller.dispose();
      await graph.dispose();
    }
  });
});
