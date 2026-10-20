import { expect, it } from 'vitest';
import {
  MULAW_8K,
  type SessionInput,
  type SpeechToText,
  type TurnDetectorFactory,
  type UserTurnController,
  type VadAnalyzerFactory,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

const session: SessionInput = {
  mode: 'faq',
  language: 'en-US',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};
const stt: SpeechToText = {
  capabilities: {
    inputFormats: [MULAW_8K],
    languages: ['en-US'],
    interim: true,
    wordTimestamps: false,
    turnSignals: ['end-of-turn'],
    forceEndpoint: true,
  },
  async start() {
    return { async write() {}, async finish() {}, async cancel() {} };
  },
};
const vad: VadAnalyzerFactory = {
  params: { confidence: 0.7, startMs: 200, stopMs: 200, minVolume: 0.6, smoothing: 0.2 },
  // 10 ms frames at 8 kHz.
  create: () => ({
    frameSamples: 80,
    sampleRate: 8000,
    confidence: () => 0,
    volume: () => 0,
    reset() {},
  }),
};

/** A turn detector that never decides anything; `audio` is its only (optional) member. */
function detector(audio?: UserTurnController['audio']): TurnDetectorFactory {
  return {
    create: () => ({
      observe() {},
      on: () => () => undefined,
      dispose() {},
      ...(audio ? { audio } : {}),
    }),
  };
}

function engineWith(turnDetector: TurnDetectorFactory, withVad = true) {
  const carrier = createFakeCarrier();
  const engine = new NativeVoiceSessionEngine({
    behavior: { respond: async () => '' },
    scheduler: new BoundedSpeechScheduler({
      async play() {
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    }),
    media: carrier.duplex,
    stt,
    session,
    turnDetector,
    ...(withVad ? { vad } : {}),
  });
  return { carrier, engine };
}

it('passes the caller audio, decoded, to a turn detector that reads it', async () => {
  const frames: { samples: number; rate: number; first: number }[] = [];
  const { carrier, engine } = engineWith(
    detector((pcm, rate) => frames.push({ samples: pcm.length, rate, first: pcm[0]! })),
  );
  await engine.start();
  // 20 ms of mu-law 0xff (a quiet zero) then 0x00 (the loudest negative): two VAD frames each.
  carrier.caller.audio(new Uint8Array(160).fill(0xff));
  carrier.caller.audio(new Uint8Array(160).fill(0x00));
  expect(frames).toHaveLength(4);
  expect(frames.every((frame) => frame.samples === 80 && frame.rate === 8000)).toBe(true);
  expect(frames[0]!.first).toBe(0);
  expect(frames[2]!.first).toBeLessThan(-30000);
  await engine.dispose('behavior_completed');
});

it('leaves a turn detector without an audio hook, and a call without a VAD, alone', async () => {
  const without = engineWith(detector());
  await without.engine.start();
  without.carrier.caller.audio(new Uint8Array(160));
  await without.engine.dispose('behavior_completed');

  // No VAD, no decoded audio: the hook is simply never called (the model gate then reads nothing).
  let calls = 0;
  const novad = engineWith(
    detector(() => calls++),
    false,
  );
  await novad.engine.start();
  novad.carrier.caller.audio(new Uint8Array(160));
  await novad.engine.dispose('behavior_completed');
  expect(calls).toBe(0);
});
