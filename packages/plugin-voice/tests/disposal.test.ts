import { expect, it } from 'vitest';
import { MULAW_8K, type SessionInput, type SpeechToText } from '@winsendotai/ovo-contracts';
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

it('disposes ingress, scheduler, and behavior when media close ignores the deadline', async () => {
  const carrier = createFakeCarrier();
  let releaseClose!: () => void;
  const closePending = new Promise<void>((resolve) => (releaseClose = resolve));
  let sttSignal: AbortSignal | undefined;
  let cancelled = 0;
  let behaviorCancelled = 0;
  const stt: SpeechToText = {
    capabilities: {
      inputFormats: [MULAW_8K],
      languages: ['en-US'],
      interim: true,
      wordTimestamps: false,
      turnSignals: ['end-of-turn'],
      forceEndpoint: false,
    },
    async start(options) {
      sttSignal = options.signal;
      return {
        async write() {},
        async finish() {},
        async cancel() {
          cancelled++;
        },
      };
    },
  };
  const speech = new BoundedSpeechScheduler({
    async play() {
      return { state: 'completed', evidence: 'simulated' };
    },
    async interrupt() {},
  });
  const engine = new NativeVoiceSessionEngine({
    behavior: {
      respond: async () => '',
      cancel: () => behaviorCancelled++,
    },
    scheduler: speech,
    media: { ...carrier.duplex, close: () => closePending },
    stt,
    session,
  });
  try {
    await engine.start();
    const result = await engine.dispose('drain', { deadlineMs: 30 });
    expect(result.reason).toBe('error:native-engine-disposal');
    expect(sttSignal?.aborted).toBe(true);
    expect(cancelled).toBe(1);
    expect(behaviorCancelled).toBeGreaterThan(0);
    await expect(speech.speak('after disposal')).rejects.toThrow('disposed');
  } finally {
    releaseClose();
    await engine.ended;
  }
});
