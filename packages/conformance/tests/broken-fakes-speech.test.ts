import { describe, expect, it } from 'vitest';
import type {
  Inference,
  InferenceStreamEvent,
  SpeechToText,
  TextToSpeech,
  TurnDecision,
  TurnDetectorFactory,
  UsageMeter,
  VadAnalyzerFactory,
} from '@winsendotai/ovo-contracts';
import {
  FixtureInference,
  FixtureSpeechToText,
  FixtureTextToSpeech,
  checkInference,
  checkSpeechToText,
  checkTextToSpeech,
  checkTurnDetector,
  checkVad,
  createReferenceTurnDetector,
  createReferenceVad,
  fixtureLlmTemplate,
  fixtureSttTemplate,
  fixtureTtsTemplate,
  type KitFailure,
} from '../src/index.ts';

const messages = (failures: KitFailure[]) => failures.map((f) => f.message).join('\n');

describe('checkTextToSpeech rejects audio that is not in the requested format', () => {
  it('flags one arbitrary buffer returned for every native format (F4)', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => {
        const real = new FixtureTextToSpeech(net, { clock });
        const broken: TextToSpeech = {
          capabilities: real.capabilities,
          cacheIdentity: (format, voice) => real.cacheIdentity(format, voice),
          async *synthesize(input) {
            // The scripted call still happens, so only the format assertions can fail.
            for await (const chunk of real.synthesize(input)) void chunk;
            yield new Uint8Array(40);
          },
        };
        return broken;
      },
      { template: fixtureTtsTemplate },
      { only: ['native format'] },
    );
    expect(messages(failures)).toMatch(/too short to be the requested audio/);
    expect(messages(failures)).toMatch(/returned byte-identical audio/);
  });

  it('flags a constant cacheIdentity that cannot tell formats or voices apart (F5)', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => ({
        capabilities: new FixtureTextToSpeech(net, { clock }).capabilities,
        cacheIdentity: () => ({
          provider: 'fixture',
          model: 'fixture-tts-1',
          voice: 'fixture-voice',
          revision: 'v1',
        }),
        synthesize: () => (async function* () {})(),
      }),
      { template: fixtureTtsTemplate },
      { only: ['cacheIdentity'] },
    );
    expect(messages(failures)).toMatch(
      /cacheIdentity is identical for .* the speech cache would serve the wrong audio/,
    );
  });
});

const meter = (): UsageMeter => ({
  provider: 'fixture',
  operation: 'stt',
  unit: 'audio_seconds',
  quantity: '0.300',
  state: 'estimated',
  requestId: 'fixture:kit-session:1',
  elapsedMs: 0,
});

describe('checkSpeechToText rejects a leaked socket and an undeclared forceEndpoint', () => {
  it('flags a cancel that answers in time but never closes the provider socket (F8)', async () => {
    const failures = await checkSpeechToText(
      ({ net, clock }) => {
        const real = new FixtureSpeechToText(net, { clock });
        const broken: SpeechToText = {
          capabilities: real.capabilities,
          async start(input) {
            const session = await real.start(input);
            let cancelled = false;
            return {
              write: (frame) =>
                cancelled ? Promise.reject(new Error('cancelled')) : session.write(frame),
              finish: async () => {
                if (!cancelled) await session.finish();
              },
              cancel: async () => {
                if (cancelled) return;
                cancelled = true;
                input.onUsage(meter());
              },
            };
          },
        };
        return broken;
      },
      { template: fixtureSttTemplate },
      { only: ['cancel closes'] },
    );
    expect(messages(failures)).toMatch(/cancel left the provider socket open/);
  });

  it('flags capabilities.forceEndpoint with no forceEndpoint on the session (F8)', async () => {
    const failures = await checkSpeechToText(
      ({ net, clock }) => {
        const real = new FixtureSpeechToText(net, { clock });
        return {
          capabilities: real.capabilities,
          async start(input) {
            const session = await real.start(input);
            return {
              write: (frame: Uint8Array) => session.write(frame),
              finish: () => session.finish(),
              cancel: (reason: string) => session.cancel(reason),
            };
          },
        };
      },
      { template: fixtureSttTemplate },
      { only: ['forceEndpoint'] },
    );
    expect(messages(failures)).toMatch(
      /capabilities\.forceEndpoint is true but the session has no forceEndpoint/,
    );
  });
});

describe('checkInference validates tool inputs and the streaming path', () => {
  it('flags a tool call whose input violates the tool schema (F10)', async () => {
    const broken: Inference = {
      provider: 'broken',
      model: 'broken-1',
      generate: async (request) =>
        request.results.length
          ? { kind: 'text', text: 'Booked.' }
          : { kind: 'tool', toolId: 'book_table', input: { party: 'two', time: 7 } },
    };
    const failures = await checkInference(
      () => broken,
      { template: fixtureLlmTemplate },
      {
        only: ['template drives'],
      },
    );
    expect(messages(failures)).toMatch(/tool input does not satisfy book_table\.inputSchema/);
  });

  it('flags a stream() that never calls the tool and never finishes (F11)', async () => {
    const failures = await checkInference(
      ({ net, usage }) => {
        const real = new FixtureInference(net, { usage });
        return {
          provider: real.provider,
          model: real.model,
          generate: (request) => real.generate(request),
          stream: async function* (): AsyncIterable<InferenceStreamEvent> {
            yield { kind: 'text-delta', delta: 'sure' };
          },
        };
      },
      { template: fixtureLlmTemplate },
      { only: ['stream()'] },
    );
    expect(messages(failures)).toMatch(/stream\(\) must end with a 'finish' event/);
    expect(messages(failures)).toMatch(/stream\(\) did not call the write tool on the first turn/);
  });
});

const vadWith = (patch: (real: VadAnalyzerFactory) => VadAnalyzerFactory) => {
  const real = createReferenceVad();
  return () => patch(real);
};

describe('checkVad rejects out-of-range analyzers and inert parameters', () => {
  it('flags a confidence outside [0, 1] (F19)', async () => {
    const failures = await checkVad(
      vadWith((real) => ({
        params: real.params,
        create: (rate) => ({ ...real.create(rate), confidence: () => 42 }),
      })),
      { only: ['silence stays'] },
    );
    expect(messages(failures)).toMatch(/confidence\(frame 0\) is 42, outside \[0, 1\]/);
  });

  it('flags a frame size that cannot carry the declared start/stop windows (F19)', async () => {
    const failures = await checkVad(
      vadWith((real) => ({
        params: real.params,
        create: (rate) => ({ ...real.create(rate), frameSamples: 1 }),
      })),
      { only: ['usable frame size'] },
    );
    expect(messages(failures)).toMatch(/samples per frame \(0\.\d+ ms\), outside 5–100 ms/);
  });

  it('flags a volume that never spans minVolume (F20)', async () => {
    const failures = await checkVad(
      vadWith((real) => ({
        params: real.params,
        create: (rate) => ({ ...real.create(rate), volume: () => 1 }),
      })),
      { only: ['volume is normalised'] },
    );
    expect(messages(failures)).toMatch(/very quiet audio reports volume 1/);
  });

  it('flags a confidence that never falls back within stopMs (F20)', async () => {
    const failures = await checkVad(
      vadWith((real) => ({
        params: real.params,
        create: (rate) => {
          const analyzer = real.create(rate);
          let peak = 0;
          return {
            ...analyzer,
            confidence: (frame) => (peak = Math.max(peak, analyzer.confidence(frame))),
            reset: () => {
              peak = 0;
              analyzer.reset();
            },
          };
        },
      })),
      { only: ['rises within startMs'] },
    );
    expect(messages(failures)).toMatch(/after speech ended the confidence is still/);
  });
});

/** The reference detector with some of its decisions withheld. */
function filtered(drop: (decision: TurnDecision) => boolean): TurnDetectorFactory {
  const real = createReferenceTurnDetector();
  return {
    create(input) {
      const controller = real.create(input);
      return {
        observe: (event) => controller.observe(event),
        dispose: () => controller.dispose(),
        on: (fn) => controller.on((decision) => (drop(decision) ? undefined : fn(decision))),
      };
    },
  };
}

describe('checkTurnDetector rejects a detector that hides its turn lifecycle', () => {
  it('flags every turn.started being dropped (F21)', async () => {
    const failures = await checkTurnDetector(() => filtered((d) => d.type === 'turn.started'));
    expect(messages(failures)).toMatch(/turn\.stopped for turn-\d+ without a turn\.started/);
  });

  it("flags missing turn.reset 'backchannel' and 'muted' decisions (F22)", async () => {
    const failures = await checkTurnDetector(() => filtered((d) => d.type === 'turn.reset'));
    expect(messages(failures)).toMatch(/no turn\.reset\{reason:'backchannel'\}/);
    expect(messages(failures)).toMatch(/no turn\.reset\{reason:'muted'\}/);
  });

  it('flags a detector that ignores the VAD and never force-endpoints (F22)', async () => {
    const providerOnly = createReferenceTurnDetector({ strategy: 'provider' });
    const failures = await checkTurnDetector(() => ({
      create: (input) => providerOnly.create({ ...input, overrides: { strategy: 'provider' } }),
    }));
    expect(messages(failures)).toMatch(/no turn\.stopped after the VAD went quiet/);
    expect(messages(failures)).toMatch(/expected one force-endpoint, saw 0/);
  });
});
