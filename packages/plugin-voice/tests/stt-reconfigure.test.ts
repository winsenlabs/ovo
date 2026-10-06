import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MULAW_8K,
  type Behavior,
  type BehaviorEvent,
  type SessionInput,
  type SpeechToText,
  type SttConfigurationUpdate,
  type SttSession,
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

/** Records, per provider session, every frame and configuration update in the order sent. */
function recordingStt(options: { reconfigurable?: boolean; refuse?: boolean } = {}) {
  const sent: (string | number)[][] = [];
  const drops: ((error: Error) => void)[] = [];
  let gate: Promise<void> | undefined;
  const stt: SpeechToText = {
    capabilities,
    async start() {
      await gate;
      const log: (string | number)[] = [];
      sent.push(log);
      let failure: Error | undefined;
      drops.push((error) => (failure = error));
      const handle: SttSession = {
        async write(frame) {
          if (failure) throw failure;
          log.push(frame[0]!);
        },
        async finish() {},
        async cancel() {},
        ...(options.reconfigurable === false
          ? {}
          : {
              async updateConfiguration(update: SttConfigurationUpdate) {
                if (options.refuse) throw new Error('provider refused the update');
                log.push(JSON.stringify(update));
              },
            }),
      };
      return handle;
    },
  };
  return {
    stt,
    sent,
    drops,
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

function ingressFor(carrier = createFakeCarrier()) {
  const ingress = new VoiceIngress(
    carrier.duplex,
    { maxFrames: 100, maxBytes: 10_000, preSttBufferMs: 10_000 },
    new AbortController().signal,
    () => undefined,
    () => undefined,
  );
  return { ingress, carrier };
}

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('live STT reconfiguration (STT-4)', () => {
  it('sends an update made while connecting before any buffered audio', async () => {
    const provider = recordingStt();
    const release = provider.hold();
    const { ingress, carrier } = ingressFor();
    const connecting = ingress.connect(provider.stt, 'en-US', () => undefined);
    carrier.caller.audio(Uint8Array.of(7));
    expect(ingress.updateConfiguration({ endpointing: 'fast' })).toBe(true);
    release();
    await connecting;
    await vi.waitFor(() => expect(provider.sent[0]).toEqual(['{"endpointing":"fast"}', 7]));
    await ingress.dispose();
  });

  it('applies an update to the connected session at once', async () => {
    const provider = recordingStt();
    const { ingress, carrier } = ingressFor();
    await ingress.connect(provider.stt, 'en-US', () => undefined);
    carrier.caller.audio(Uint8Array.of(1));
    await vi.waitFor(() => expect(provider.sent[0]).toEqual([1]));
    expect(ingress.updateConfiguration({ maxTurnSilenceMs: 500 })).toBe(true);
    await vi.waitFor(() => expect(provider.sent[0]).toEqual([1, '{"maxTurnSilenceMs":500}']));
    await ingress.dispose();
  });

  it('gives a reconnected session the whole configuration so far', async () => {
    const provider = recordingStt();
    const { ingress, carrier } = ingressFor();
    await ingress.connect(provider.stt, 'en-US', () => undefined);
    ingress.updateConfiguration({ endpointing: 'patient' });
    ingress.updateConfiguration({ vadThreshold: 0.6 });
    provider.drops[0]!(Object.assign(new Error('drop'), { code: 1011, retryable: true }));
    carrier.caller.audio(Uint8Array.of(2));
    await vi.waitFor(() => expect(provider.sent).toHaveLength(2));
    await vi.waitFor(() =>
      expect(provider.sent[1]![0]).toBe('{"endpointing":"patient","vadThreshold":0.6}'),
    );
    await ingress.dispose();
  });

  it('reports a provider that fixes its configuration at connect, and survives a refusal', async () => {
    const fixed = recordingStt({ reconfigurable: false });
    const first = ingressFor();
    await first.ingress.connect(fixed.stt, 'en-US', () => undefined);
    expect(first.ingress.updateConfiguration({ endpointing: 'fast' })).toBe(false);
    await first.ingress.dispose();
    const refusing = recordingStt({ refuse: true });
    const second = ingressFor();
    await second.ingress.connect(refusing.stt, 'en-US', () => undefined);
    expect(second.ingress.updateConfiguration({ endpointing: 'fast' })).toBe(true);
    second.carrier.caller.audio(Uint8Array.of(3));
    await vi.waitFor(() => expect(refusing.sent[0]).toEqual([3]));
    await second.ingress.dispose();
  });

  it("follows a behaviour's stt.configure event through the engine", async () => {
    const provider = recordingStt();
    const listeners = new Set<(event: BehaviorEvent) => void>();
    const behavior: Behavior = {
      respond: async () => '',
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const carrier = createFakeCarrier();
    const engine = new NativeVoiceSessionEngine({
      behavior,
      scheduler: new BoundedSpeechScheduler({
        async play() {
          return { state: 'completed', evidence: 'simulated' };
        },
        async interrupt() {},
      }),
      media: carrier.duplex,
      stt: provider.stt,
      session,
    });
    expect(engine.configureStt({ endpointing: 'fast' })).toBe(false);
    await engine.start();
    const event = { type: 'stt.configure', update: { minTurnSilenceMs: 160 } };
    for (const listener of listeners) listener(event as unknown as BehaviorEvent);
    await vi.waitFor(() => expect(provider.sent[0]).toEqual(['{"minTurnSilenceMs":160}']));
    expect(engine.configureStt({ maxTurnSilenceMs: 400 })).toBe(true);
    await engine.dispose('drain');
  });
});
