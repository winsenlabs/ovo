import { describe, expect, it } from 'vitest';
import type {
  AudioFormat,
  Clock,
  IncrementalTts,
  NetFixtureScript,
  NetPort,
  SynthesisInput,
  TextToSpeech,
} from '@winsendotai/ovo-contracts';
import {
  FIXTURE_DOCS,
  FIXTURE_HOST,
  FIXTURE_RETRIEVED,
  FixtureTextToSpeech,
  checkTextToSpeech,
  fixtureTtsTemplate,
  splitText,
  type KitFailure,
  type TtsKitOptions,
} from '../src/index.ts';

const messages = (failures: KitFailure[]) => failures.map((f) => f.message).join('\n');

interface Breakage {
  doubleUsage?: boolean;
  ignoreAbort?: boolean;
  closeThrows?: boolean;
  sharedRequestId?: boolean;
}

/** A reference incremental TTS over the fixture HTTP TTS: text is held until flush. */
function incrementalFixture(net: NetPort, clock: Clock, broken: Breakage = {}): TextToSpeech {
  const real = new FixtureTextToSpeech(net, { clock });
  return {
    capabilities: { ...real.capabilities, incrementalText: true },
    cacheIdentity: (format, voice) => real.cacheIdentity(format, voice),
    synthesize: (input) => real.synthesize(input),
    async open(input: Omit<SynthesisInput, 'text'>): Promise<IncrementalTts> {
      let text = '';
      let failed = false;
      const flushed = Promise.withResolvers<void>();
      const signal = broken.ignoreAbort ? new AbortController().signal : input.signal;
      const audio = (async function* () {
        await flushed.promise;
        try {
          const onUsage: typeof input.onUsage = broken.sharedRequestId
            ? (meter) => input.onUsage({ ...meter, requestId: 'fixture:same' })
            : input.onUsage;
          for await (const chunk of real.synthesize({ ...input, signal, text, onUsage })) {
            yield chunk;
            if (broken.ignoreAbort) for (let extra = 0; extra < 3; extra += 1) yield chunk;
          }
        } catch (error) {
          failed = true;
          throw error;
        }
      })();
      return {
        push: (piece) => {
          text += piece;
        },
        flush: () => flushed.resolve(),
        audio,
        async close() {
          flushed.resolve();
          await audio.return(undefined);
          if (broken.doubleUsage)
            input.onUsage({
              provider: 'fixture',
              operation: 'tts',
              unit: 'characters',
              quantity: '1',
              state: 'estimated',
              requestId: 'fixture:again',
              elapsedMs: 0,
            });
          if (broken.closeThrows && failed) throw new Error('close after failure');
        },
      };
    },
  };
}

const failingScripts = (): NetFixtureScript[] => [
  {
    host: FIXTURE_HOST,
    source: `${FIXTURE_DOCS}/tts`,
    retrieved: FIXTURE_RETRIEVED,
    steps: [
      {
        expect: 'http',
        method: 'POST',
        url: `https://${FIXTURE_HOST}/v1/tts`,
        reply: { status: 500, body: 'fixture outage' },
      },
    ],
  },
];

const options: TtsKitOptions = {
  template: fixtureTtsTemplate,
  incrementalPushes: 2,
  incrementalFailure: (_format: AudioFormat) => failingScripts(),
};

describe('checkTextToSpeech incremental invariants (TTS-12)', () => {
  it('splits text into the requested number of pieces without losing characters', () => {
    expect(splitText('abcdefg', 2)).toEqual(['abcd', 'efg']);
    expect(splitText('नमस्ते', 1)).toEqual(['नमस्ते']);
    expect(splitText('ab', 5)).toEqual(['a', 'b']);
  });

  it('passes the reference incremental fixture', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => incrementalFixture(net, clock),
      { ...options, distinctRequestIds: true },
      { only: ['incremental'] },
    );
    expect(messages(failures)).toBe('');
  });

  it('flags usage emitted again by a second close', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => incrementalFixture(net, clock, { doubleUsage: true }),
      options,
      { only: ['meters once on close'] },
    );
    // The stream's own meter plus one per close() call: the check closes twice.
    expect(messages(failures)).toMatch(/usage characters emitted 3 times/);
  });

  it('flags utterances that share a usage requestId when distinctRequestIds is set', async () => {
    const shared = ({ net, clock }: { net: NetPort; clock: Clock }) =>
      incrementalFixture(net, clock, { sharedRequestId: true });
    const only = { only: ['two sequential open()'] };
    expect(messages(await checkTextToSpeech(shared, options, only))).toBe('');
    expect(
      messages(await checkTextToSpeech(shared, { ...options, distinctRequestIds: true }, only)),
    ).toMatch(/utterances share a usage requestId: fixture:same,fixture:same/);
  });

  it('flags audio that keeps coming after an abort', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => incrementalFixture(net, clock, { ignoreAbort: true }),
      options,
      { only: ['abort stops the audio'] },
    );
    expect(messages(failures)).toMatch(/chunks arrived after abort/);
  });

  it('flags a close that throws after a provider failure', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => incrementalFixture(net, clock, { closeThrows: true }),
      options,
      { only: ['close after a provider error'] },
    );
    expect(messages(failures)).toMatch(/close\(\) threw after a provider error/);
  });

  it('flags incrementalText declared without open()', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => {
        const real = new FixtureTextToSpeech(net, { clock });
        return {
          capabilities: { ...real.capabilities, incrementalText: true },
          cacheIdentity: (format, voice) => real.cacheIdentity(format, voice),
          synthesize: (input) => real.synthesize(input),
        };
      },
      options,
      { only: ['open → push → flush'] },
    );
    expect(messages(failures)).toMatch(/incrementalText is true but the plugin has no open\(\)/);
  });

  it('flags a cacheIdentity that ignores an audio-affecting binding field (TTS-13)', async () => {
    const failures = await checkTextToSpeech(
      ({ net, clock }) => new FixtureTextToSpeech(net, { clock }),
      {
        ...options,
        identityVariants: [
          { name: 'speed', factory: ({ net, clock }) => new FixtureTextToSpeech(net, { clock }) },
        ],
      },
      { only: ['audio-affecting binding field'] },
    );
    expect(messages(failures)).toMatch(
      /changing speed keeps the same cacheIdentity, so cached clips would play the old voice/,
    );
  });
});
