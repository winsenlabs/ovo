import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Cap,
  MULAW_8K,
  PCM16_8K,
  type SessionInput,
  type SpeechToText,
  type SttEvent,
  type SttSession,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { createFakeCarrier } from '../../../packages/conformance/src/drivers/fake-carrier.ts';
import { NativeVoiceSessionEngine } from '../../../packages/plugin-voice/src/engine/session-engine.ts';
import { BoundedSpeechScheduler } from '../../../packages/plugin-voice/src/scheduler.ts';
import { adoptPreconnectedStt, SttPreconnect } from '../src/session-stt-preconnect.ts';

const HANDSHAKE_MS = 2_000;
const SETUP_MS = 300;
const capabilities = {
  inputFormats: [MULAW_8K],
  languages: ['*'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: false,
} as const;
const meter: UsageMeter = {
  provider: 'fixture',
  operation: 'stt',
  unit: 'session_seconds',
  quantity: '1',
  state: 'estimated',
  requestId: 'fixture-1',
  elapsedMs: 1,
};

/** A provider whose handshake takes `HANDSHAKE_MS` on the fake clock, as Begin does live. */
function slowStt(
  options: { fail?: boolean; early?: (input: Parameters<SpeechToText['start']>[0]) => void } = {},
) {
  const starts: string[] = [];
  const cancelled: string[] = [];
  const stt: SpeechToText = {
    capabilities,
    async start(input) {
      starts.push(input.sessionId);
      await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_MS));
      if (options.fail) throw Object.assign(new Error('Begin refused'), { retryable: true });
      options.early?.(input);
      const session: SttSession = {
        async write() {},
        async finish() {},
        async cancel(reason) {
          cancelled.push(reason);
          input.onUsage(meter);
        },
      };
      return session;
    },
  };
  return { stt, starts, cancelled };
}

/** The session's STT plugin, through the same decoration the live graph applies. */
async function sessionStt(stt: SpeechToText, preconnect?: SttPreconnect) {
  const plugin = definePlugin(
    {
      id: '@fixture/slow-stt',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'stt',
      provider: 'fixture',
      provides: [`${Cap.stt}@2`],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities,
      meters: [{ key: 'fixture.stt.audio', unit: 'audio_seconds', label: 'Audio', role: 'stt' }],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['stt@1'],
    },
    (ctx) => {
      ctx.provide(Cap.stt, stt);
    },
  );
  const definition = preconnect ? adoptPreconnectedStt(plugin, preconnect) : plugin;
  const composition = await compose([{ id: definition.manifest.id }], [definition], {
    scope: 'session',
  });
  return { stt: composition.get(Cap.stt) as SpeechToText, composition };
}

const session: SessionInput = {
  mode: 'faq',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

function engineFor(stt: SpeechToText) {
  const carrier = createFakeCarrier();
  return new NativeVoiceSessionEngine({
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
}

const early =
  (stt: SpeechToText, closed: string[] = []) =>
  async () => ({
    stt,
    close: async () => void closed.push('closed'),
  });
const target = { sessionId: 'session-1', format: MULAW_8K, language: 'en-IN' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('STT connect at session.open (STT-6)', () => {
  it('makes STT ready after max(setup, handshake) instead of their sum', async () => {
    vi.useFakeTimers({ now: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ready = async (preconnected: boolean) => {
      const provider = slowStt();
      const openedAt = Date.now();
      const preconnect = preconnected
        ? new SttPreconnect(early(provider.stt), target, () => undefined)
        : undefined;
      // Call record, telemetry, recording, carrier and graph composition.
      await vi.advanceTimersByTimeAsync(SETUP_MS);
      const composed = await sessionStt(provider.stt, preconnect);
      const engine = engineFor(composed.stt);
      let readyAt = 0;
      const starting = engine.start().then(() => (readyAt = Date.now()));
      await vi.advanceTimersByTimeAsync(HANDSHAKE_MS);
      await starting;
      expect(provider.starts).toHaveLength(1);
      await engine.dispose('drain');
      await preconnect?.dispose();
      await composed.composition.dispose();
      return readyAt - openedAt;
    };
    const before = await ready(false);
    const after = await ready(true);
    // Measured on the fake clock: 300 ms of setup no longer delays a 2 s handshake.
    expect({ before, after }).toEqual({ before: SETUP_MS + HANDSHAKE_MS, after: HANDSHAKE_MS });
  });

  it('hands over what the early session heard and metered before it was adopted', async () => {
    vi.useFakeTimers({ now: 0 });
    const said: SttEvent = { type: 'speech-start', atMs: 5 };
    const provider = slowStt({
      early: (input) => {
        input.onEvent(said);
        input.onUsage(meter);
      },
    });
    const preconnect = new SttPreconnect(early(provider.stt), target, () => undefined);
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS);
    const events: SttEvent[] = [];
    const meters: UsageMeter[] = [];
    const adopted = await preconnect.adopt({
      ...target,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onUsage: (usage) => meters.push(usage),
    });
    expect(adopted).toBeDefined();
    expect(events).toEqual([said]);
    expect(meters).toEqual([meter]);
    expect(preconnect.summary()).toEqual({ adopted: true, handshakeMs: HANDSHAKE_MS });
    // Only the first start adopts; a reconnect connects afresh.
    expect(
      await preconnect.adopt({
        ...target,
        signal: new AbortController().signal,
        onEvent: () => undefined,
        onUsage: () => undefined,
      }),
    ).toBeUndefined();
  });

  it('connects afresh when the early handshake failed or was opened for another format', async () => {
    vi.useFakeTimers({ now: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = slowStt({ fail: true });
    const failing = new SttPreconnect(early(refused.stt), target, () => undefined);
    const fresh = slowStt();
    const composed = await sessionStt(fresh.stt, failing);
    const starting = composed.stt.start({
      ...target,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onUsage: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(2 * HANDSHAKE_MS);
    await expect(starting).resolves.toBeDefined();
    expect(fresh.starts).toEqual(['session-1']);
    const pcm = new SttPreconnect(
      early(slowStt().stt),
      { ...target, format: PCM16_8K },
      () => undefined,
    );
    expect(
      await pcm.adopt({
        ...target,
        signal: new AbortController().signal,
        onEvent: () => undefined,
        onUsage: () => undefined,
      }),
    ).toBeUndefined();
    await failing.dispose();
    await composed.composition.dispose();
  });

  it('cancels an early session nobody adopted and charges its usage to the call', async () => {
    vi.useFakeTimers({ now: 0 });
    const provider = slowStt();
    const closed: string[] = [];
    const charged: UsageMeter[] = [];
    const preconnect = new SttPreconnect(early(provider.stt, closed), target, (usage) =>
      charged.push(usage),
    );
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS);
    await Promise.all([preconnect.dispose(), preconnect.dispose()]);
    expect(provider.cancelled).toEqual(['not adopted']);
    expect(charged).toEqual([meter]);
    expect(closed).toEqual(['closed']);
    expect(preconnect.summary()).toMatchObject({ adopted: false });
  });
});
