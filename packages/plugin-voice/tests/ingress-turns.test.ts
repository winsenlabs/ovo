import { expect, it } from 'vitest';
import {
  MULAW_8K,
  type SessionInput,
  type SpeechToText,
  type TurnDecision,
  type TurnDetectorFactory,
  type UserTurnController,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { VoiceIngress } from '../src/engine/ingress.ts';
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
const capabilities = {
  inputFormats: [MULAW_8K],
  languages: ['en-US'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: true,
} as const;

it('buffers original carrier frames until STT connects and decodes only for VAD', async () => {
  const carrier = createFakeCarrier();
  const events: VoiceEvent[] = [];
  const writes: number[][] = [];
  const seenPcm: number[][] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const stt: SpeechToText = {
    capabilities,
    async start() {
      await gate;
      return {
        async write(frame) {
          writes.push([...frame]);
        },
        async finish() {},
        async cancel() {},
      };
    },
  };
  const ingress = new VoiceIngress(
    carrier.duplex,
    { maxFrames: 4, maxBytes: 64, preSttBufferMs: 5000 },
    new AbortController().signal,
    (event) => events.push(event),
    () => {
      throw new Error('unexpected overflow');
    },
    {
      params: { confidence: 0.7, startMs: 200, stopMs: 200, minVolume: 0.6, smoothing: 0.2 },
      create: () => ({
        frameSamples: 2,
        sampleRate: 8000,
        confidence(pcm) {
          seenPcm.push([...pcm]);
          return 1;
        },
        volume: () => 1,
        reset() {},
      }),
    },
  );
  const connecting = ingress.connect(stt, 'en-US', () => undefined);
  carrier.caller.audio(Uint8Array.of(0xff, 0x7f));
  carrier.caller.audio(Uint8Array.of(0x00, 0xff));
  expect(ingress.stats).toMatchObject({ acceptedFrames: 2, pendingFrames: 2 });
  open();
  await connecting;
  await waitFor(() => writes.length === 2);
  expect(writes).toEqual([
    [0xff, 0x7f],
    [0x00, 0xff],
  ]);
  expect(seenPcm).toHaveLength(2);
  expect(events.some((event) => event.type === 'vad.start')).toBe(true);
  await ingress.dispose();
});

it('fails closed on bounded pre-STT overflow', async () => {
  const carrier = createFakeCarrier();
  let refused = 0;
  const ingress = new VoiceIngress(
    carrier.duplex,
    { maxFrames: 1, maxBytes: 4, preSttBufferMs: 5000 },
    new AbortController().signal,
    () => undefined,
    () => refused++,
  );
  carrier.caller.audio(Uint8Array.of(1));
  carrier.caller.audio(Uint8Array.of(2));
  expect(refused).toBe(1);
  expect(ingress.stats).toMatchObject({ acceptedFrames: 1, overflows: 1 });
  await ingress.dispose();
});

it('cancels an STT session that finishes connecting after ingress disposal', async () => {
  const carrier = createFakeCarrier();
  let connect!: () => void;
  const gate = new Promise<void>((resolve) => (connect = resolve));
  let cancels = 0;
  const ingress = new VoiceIngress(
    carrier.duplex,
    { maxFrames: 250, maxBytes: 40_000, preSttBufferMs: 5000 },
    new AbortController().signal,
    () => undefined,
    () => undefined,
  );
  const starting = ingress.connect(
    {
      capabilities,
      async start() {
        await gate;
        return {
          async write() {},
          async finish() {},
          async cancel() {
            cancels++;
          },
        };
      },
    },
    'en-US',
    () => undefined,
  );
  const rejected = expect(starting).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  await ingress.dispose();
  await rejected;
  connect();
  await waitFor(() => cancels === 1);
  expect(cancels).toBe(1);
});

it('holds five seconds of standard carrier frames before STT connects by default', async () => {
  const carrier = createFakeCarrier();
  let connect!: () => void;
  const gate = new Promise<void>((resolve) => (connect = resolve));
  const stt: SpeechToText = {
    capabilities,
    async start() {
      await gate;
      return { async write() {}, async finish() {}, async cancel() {} };
    },
  };
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
  });
  const starting = engine.start();
  try {
    for (let frame = 0; frame < 250; frame++) carrier.caller.audio(new Uint8Array(160));
    expect(engine.ingressStats).toMatchObject({
      acceptedFrames: 250,
      acceptedBytes: 40_000,
      overflows: 0,
    });
  } finally {
    connect();
    await starting;
    await engine.dispose('drain');
  }
});

it('forwards the selected detector force-endpoint decision to STT', async () => {
  const carrier = createFakeCarrier();
  let endpointCalls = 0;
  let decide!: (decision: TurnDecision) => void;
  const factory: TurnDetectorFactory = {
    create(): UserTurnController {
      const listeners = new Set<(decision: TurnDecision) => void>();
      decide = (decision) => {
        for (const listener of listeners) listener(decision);
      };
      return {
        observe() {},
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        dispose() {},
      };
    },
  };
  const stt: SpeechToText = {
    capabilities,
    async start() {
      return {
        async write() {},
        async forceEndpoint() {
          endpointCalls++;
        },
        async finish() {},
        async cancel() {},
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
    behavior: { respond: async () => '' },
    scheduler: speech,
    media: carrier.duplex,
    stt,
    turnDetector: factory,
    session,
  });
  await engine.start();
  decide({ type: 'force-endpoint' });
  await waitFor(() => endpointCalls === 1);
  await engine.dispose('drain');
});

it('orders a force-endpoint requested during STT connection after buffered speech', async () => {
  const carrier = createFakeCarrier();
  let connect!: () => void;
  const gate = new Promise<void>((resolve) => (connect = resolve));
  let decide!: (decision: TurnDecision) => void;
  const operations: string[] = [];
  const factory: TurnDetectorFactory = {
    create() {
      const listeners = new Set<(decision: TurnDecision) => void>();
      decide = (decision) => {
        for (const listener of listeners) listener(decision);
      };
      return {
        observe() {},
        on(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {},
      };
    },
  };
  const stt: SpeechToText = {
    capabilities,
    async start() {
      await gate;
      return {
        async write(frame) {
          operations.push(`write:${frame[0]}`);
        },
        async forceEndpoint() {
          operations.push('force');
        },
        async finish() {},
        async cancel() {},
      };
    },
  };
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
    turnDetector: factory,
    session,
  });
  const starting = engine.start();
  try {
    carrier.caller.audio(Uint8Array.of(1));
    carrier.caller.audio(Uint8Array.of(2));
    decide({ type: 'force-endpoint' });
    carrier.caller.audio(Uint8Array.of(3));
    connect();
    await starting;
    await waitFor(() => operations.includes('write:3'));
    expect(operations).toEqual(['write:1', 'write:2', 'force', 'write:3']);
  } finally {
    connect();
    await starting;
    await engine.dispose('drain');
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for native engine condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
