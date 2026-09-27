import { expect, it } from 'vitest';
import { type EngineOutcome } from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

it.each(['playback', 'receipt-hook'] as const)(
  'ends a pending behavior stream immediately when %s fails',
  async (failure) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ended: EngineOutcome | undefined;
    let cancelled = false;
    const carrier = createFakeCarrier();
    const scheduler = new BoundedSpeechScheduler({
      async play() {
        if (failure === 'playback') throw new Error('TTS provider failed');
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    });
    const engine = new NativeVoiceSessionEngine({
      behavior: {
        async respond() {
          return '';
        },
        async *respondStream() {
          yield 'first sentence';
          await pending;
        },
        onPlayback() {
          if (failure === 'receipt-hook') throw new Error('receipt delivery failed');
        },
        isComplete: () => true,
        cancel() {
          cancelled = true;
        },
      },
      scheduler,
      media: carrier.duplex,
      session: {
        mode: 'announcement',
        language: 'en-US',
        inputEnabled: false,
        variables: {},
        maxCallSeconds: 60,
        acknowledgements: [],
      },
    });
    void engine.ended.then((result) => {
      ended = result;
    });
    try {
      await engine.start();
      await expect.poll(() => ended?.reason, { timeout: 200 }).toBe('error:turn');
      expect(ended?.outcome).toBe('failed');
      expect(cancelled).toBe(true);
      expect(carrier.closed).toBe(true);
    } finally {
      release();
      await engine.dispose('drain');
    }
  },
);
