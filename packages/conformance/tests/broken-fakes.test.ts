import { describe, expect, it } from 'vitest';
import type {
  SpeechToText,
  TextToSpeech,
  TurnDetectorFactory,
  TurnDecision,
} from '@winsendotai/ovo-contracts';
import {
  FixtureInference,
  FixtureSpeechToText,
  FixtureTextToSpeech,
  checkCarrier,
  checkEngine,
  checkInference,
  checkSpeechToText,
  checkTextToSpeech,
  checkTurnDetector,
  checkVad,
  createReferenceEngine,
  createReferenceVad,
  fixtureCarrierControl,
  fixtureCarrierIngress,
  fixtureCarrierKitOptions,
  fixtureLlmTemplate,
  fixtureSttTemplate,
  fixtureTtsTemplate,
  type KitFailure,
} from '../src/index.ts';

const checks = (failures: KitFailure[]) => new Set(failures.map((f) => f.check));
const messages = (failures: KitFailure[]) => failures.map((f) => f.message).join('\n');

describe('checkSpeechToText reports broken fakes', () => {
  it('flags usage emitted twice', async () => {
    const failures = await checkSpeechToText(
      ({ net, clock }) => {
        const real = new FixtureSpeechToText(net, { clock });
        return {
          capabilities: real.capabilities,
          start: (input) =>
            real.start({ ...input, onUsage: (m) => (input.onUsage(m), input.onUsage(m)) }),
        };
      },
      { template: fixtureSttTemplate },
    );
    expect(messages(failures)).toMatch(/usage audio_seconds emitted 2 times/);
  });

  it('flags network that bypasses the NetPort', async () => {
    const bypass: SpeechToText = {
      capabilities: new FixtureSpeechToText({
        fetch: fetch,
        websocket: () => {
          throw new Error('unused');
        },
      }).capabilities,
      async start() {
        await fetch('https://fixture.invalid/leak');
        throw new Error('unreachable');
      },
    };
    const failures = await checkSpeechToText(() => bypass, { template: fixtureSttTemplate });
    expect(messages(failures)).toMatch(/Egress blocked/);
  });

  it('flags a provider that returns final text but skips the scripted finish frame', async () => {
    const failures = await checkSpeechToText(
      ({ net, clock }) => {
        const real = new FixtureSpeechToText(net, { clock });
        return {
          capabilities: real.capabilities,
          async start(input) {
            const session = await real.start(input);
            let finished = false;
            return {
              write: (frame: Uint8Array) =>
                finished ? Promise.reject(new Error('finished')) : session.write(frame),
              async finish() {
                finished = true;
                input.onUsage({
                  provider: 'fixture',
                  operation: 'stt',
                  unit: 'audio_seconds',
                  quantity: '1',
                  state: 'estimated',
                  requestId: 'fixture:kit-session:1',
                  elapsedMs: 0,
                });
              },
              cancel: (reason: string) => session.cancel(reason),
            };
          },
        };
      },
      { template: fixtureSttTemplate },
      { only: ['scripted utterance'] },
    );
    expect(messages(failures)).toMatch(/unconsumed step .*finish/);
  });
});

describe('checkTextToSpeech reports broken fakes', () => {
  it('flags silent resampling and unstable cache identities', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => {
        const real = new FixtureTextToSpeech(net, { clock });
        const broken: TextToSpeech = {
          capabilities: real.capabilities,
          cacheIdentity: (format) => ({
            ...real.cacheIdentity(format),
            revision: String(Math.random()),
          }),
          async *synthesize(input) {
            yield new Uint8Array(160);
            yield* real.synthesize(input);
          },
        };
        return broken;
      },
      { template: fixtureTtsTemplate },
    );
    expect(checks(failures)).toContain('a non-native format is refused (plugins never resample)');
    expect(checks(failures)).toContain('cacheIdentity is stable and complete');
  });
});

describe('checkInference reports broken fakes', () => {
  it('flags a missing provider/model and a model that never calls the tool', async () => {
    const failures = await checkInference(
      () => ({ generate: async () => ({ kind: 'text', text: 'sure' }) }),
      { template: fixtureLlmTemplate },
    );
    expect(checks(failures)).toContain('exposes provider and model');
    expect(messages(failures)).toMatch(/not a tool call/);
    expect(
      await checkInference(({ net, usage }) => new FixtureInference(net, { usage }), {
        template: fixtureLlmTemplate,
      }),
    ).toEqual([]);
  });
});

describe('checkVad and checkTurnDetector report broken fakes', () => {
  it('flags a VAD that calls silence speech', async () => {
    const real = createReferenceVad();
    const failures = await checkVad(() => ({
      params: real.params,
      create: (rate) => ({ ...real.create(rate), confidence: () => 1 }),
    }));
    expect(messages(failures)).toMatch(/silence reached 1/);
  });

  it('flags a detector that ignores mute rules and confirmation buffering', async () => {
    const naive: TurnDetectorFactory = {
      create() {
        const listeners = new Set<(d: TurnDecision) => void>();
        let n = 0;
        return {
          on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
          dispose: () => listeners.clear(),
          observe(event) {
            if (
              event.type === 'stt' &&
              event.event.type === 'transcript' &&
              event.event.segment.stability === 'final'
            )
              for (const fn of listeners) {
                fn({ type: 'interrupt', reason: 'transcript' });
                fn({
                  type: 'turn.stopped',
                  turnId: `t${++n}`,
                  input: { kind: 'speech', text: event.event.segment.text, segments: 1 },
                });
              }
          },
        };
      },
    };
    const failures = await checkTurnDetector(() => naive);
    expect(checks(failures)).toContain(
      "'yes' during the confirmation prompt is buffered and released at bot.stopped",
    );
    expect(checks(failures)).toContain('announcement mode never barges in');
    expect(checks(failures)).toContain('during tools speech is discarded but DTMF is allowed');
  });
});

describe('checkCarrier reports broken fakes', () => {
  it('flags a dial that accepts https media URLs and routes that skip the url-secret', async () => {
    const failures = await checkCarrier(({ net }) => {
      const control = fixtureCarrierControl(net);
      const ingress = fixtureCarrierIngress();
      return {
        control: {
          capabilities: control.capabilities,
          create: (b) => ({
            ...control.create(b),
            dial: async (r) => ({ kind: 'accepted', requestId: r.requestId }),
          }),
        },
        ingress: {
          ...ingress,
          routes: ingress.routes.map((route) => ({
            ...route,
            handle: (request, host) =>
              route.handle(request, { ...host, verifyUrlSecret: () => true }),
          })),
        },
      };
    }, fixtureCarrierKitOptions());
    expect(checks(failures)).toContain(
      'dial rejects a non-wss or query-bearing media URL without any REST call',
    );
    expect(checks(failures)).toContain('per-call routes verify the url-secret');
  });

  it('flags a carrier that catches a direct fetch and still completes its FixtureNet call', async () => {
    const failures = await checkCarrier(
      ({ net }) => {
        const control = fixtureCarrierControl(net);
        return {
          control: {
            capabilities: control.capabilities,
            create(binding) {
              const real = control.create(binding);
              return {
                ...real,
                async dial(request) {
                  await fetch('https://fixture.invalid/bypass').catch(() => undefined);
                  return real.dial(request);
                },
              };
            },
          },
          ingress: fixtureCarrierIngress(),
        };
      },
      fixtureCarrierKitOptions(),
      { only: ['REST shapes'] },
    );
    expect(messages(failures)).toMatch(/network bypassed the NetPort: fetch/);
  });
});

describe('checkEngine reports broken engines', () => {
  it('flags an engine that never delivers receipts and drops session variables', async () => {
    const failures = await checkEngine(
      (ports) =>
        createReferenceEngine({
          ...ports,
          behavior: {
            ...ports.behavior,
            respond: (input) => ports.behavior.respond(input),
            ...(ports.behavior.respondStream
              ? { respondStream: (input: string) => ports.behavior.respondStream!(input) }
              : {}),
            onPlayback: undefined,
          },
        }),
      {},
      { only: ['confirmed write executes', 'FAQ answers', 'barge-in'] },
    );
    expect(messages(failures)).toMatch(
      /dispatched before the receipt|did not receive the session variables/,
    );
    expect(checks(failures).size).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
