import { expect, it, vi } from 'vitest';
import { MULAW_8K, type SpeechToText, type SttSession } from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { FakeClock, flushMicrotasks } from '../../conformance/src/drivers/fake-clock.ts';
import { NativeVoiceSessionEngine } from '../src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

function engineWith(start: SpeechToText['start']) {
  const clock = new FakeClock();
  const carrier = createFakeCarrier({ clock });
  const engine = new NativeVoiceSessionEngine({
    clock,
    media: carrier.duplex,
    behavior: { respond: async () => '' },
    scheduler: new BoundedSpeechScheduler({
      async play() {
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    }),
    stt: {
      capabilities: {
        inputFormats: [MULAW_8K],
        languages: ['en-IN'],
        interim: true,
        wordTimestamps: false,
        turnSignals: ['end-of-turn'],
        forceEndpoint: false,
      },
      start,
    },
    session: {
      mode: 'faq',
      language: 'en-IN',
      inputEnabled: true,
      variables: {},
      maxCallSeconds: 1,
      acknowledgements: [],
    },
  });
  const result: { state: string; error?: unknown } = { state: 'pending' };
  void engine.start().then(
    () => {
      result.state = 'resolved';
    },
    (error: unknown) => {
      result.state = 'rejected';
      result.error = error;
    },
  );
  return { clock, carrier, engine, result };
}

it.each(['watchdog', 'dispose', 'caller-close'] as const)(
  '%s settles engine startup even when STT never settles or honors abort',
  async (trigger) => {
    const { clock, carrier, engine, result } = engineWith(() => new Promise(() => undefined));
    await flushMicrotasks();
    if (trigger === 'watchdog') await clock.advanceAsync(1000);
    else if (trigger === 'dispose') await engine.dispose('drain');
    else carrier.caller.hangup();
    await engine.ended;
    await flushMicrotasks();
    expect(result.state).toBe('rejected');
    expect(result.error).toMatchObject({ name: 'AbortError' });
    expect(carrier.closed).toBe(true);
  },
);

it('cancels a late STT session after startup has already rejected on disposal', async () => {
  let resolve!: (session: SttSession) => void;
  const pending = new Promise<SttSession>((done) => {
    resolve = done;
  });
  const { engine, result } = engineWith(() => pending);
  await flushMicrotasks();
  await engine.dispose('drain');
  await flushMicrotasks();
  expect(result.state).toBe('rejected');
  const cancel = vi.fn(async () => undefined);
  resolve({ async write() {}, async finish() {}, cancel });
  await flushMicrotasks();
  expect(cancel).toHaveBeenCalledExactlyOnceWith('engine disposed');
});
