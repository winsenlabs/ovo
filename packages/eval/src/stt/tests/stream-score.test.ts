import { describe, expect, it } from 'vitest';
import type { NetFixtureScript, NetFixtureStep } from '../../../../contracts/src/index.ts';
import { pcm16ToMulaw } from '../../../../audio/src/index.ts';
import { speechLikePcm16 } from '../../../../conformance/src/drivers/audio-gen.ts';
import { createFixtureNet } from '../../../../plugin-kit/src/index.ts';
import {
  committed,
  committedWords,
  partial,
  sessionStarted,
} from '../../../../plugin-stt-elevenlabs/src/testing.ts';
import { STT_CONFIGS, configById, configStatus } from '../configs.ts';
import type { GoldCall, GoldUtterance } from '../gold.ts';
import { finalText, heardText } from '../hypothesis.ts';
import { scoreUtterance, summarize } from '../score.ts';
import { reportedLanguage, streamCall, tapNet, type StreamUtterance } from '../stream.ts';
import { formatReport } from '../report.ts';

const AUDIO: NetFixtureStep = {
  expect: 'ws-send',
  match: 'json',
  where: { message_type: 'input_audio_chunk' },
  repeat: 'until-next',
};
const COMMIT: NetFixtureStep = {
  expect: 'ws-send',
  match: 'json',
  where: { message_type: 'input_audio_chunk', commit: true },
};

/** Scribe answering each host commit with `say` and the word message's detected language. */
function scribeScript(turns: readonly { say: string; language: string }[]): NetFixtureScript[] {
  return [
    {
      host: 'api.elevenlabs.io',
      source: 'https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime',
      retrieved: '2026-10-14',
      steps: [
        {
          expect: 'ws-open',
          url: /^wss:\/\/api\.elevenlabs\.io\/v1\/speech-to-text\/realtime\?.*include_language_detection=true/,
        },
        { send: sessionStarted() },
        ...turns.flatMap(({ say, language }): NetFixtureStep[] => [
          AUDIO,
          { send: partial(say.split(' ')[0]!) },
          COMMIT,
          { send: committed(say) },
          { send: committedWords(say, [], language) },
        ]),
        AUDIO,
      ],
    },
  ];
}

/** A 600 ms burst of speech-like audio after a 200 ms lead-in, committed 200 ms after it ends. */
function window(id: string, seed: number): StreamUtterance {
  const samples = new Int16Array(800 * 8);
  samples.set(speechLikePcm16({ seed, ms: 600, rate: 8_000 }), 200 * 8);
  return { id, audio: pcm16ToMulaw(samples), commitAtMs: [1_000], speechEndMs: 800 };
}

const region = (index: number) => ({
  id: `c9-u0${index + 1}`,
  startMs: index * 10_000,
  endMs: index * 10_000 + 800,
  audioStartMs: index * 10_000,
  audioEndMs: index * 10_000 + 800,
  productionTurnIds: [],
  productionText: '',
  candidates: {},
  note: '',
});

function gold(utterances: Partial<GoldUtterance>[], nonSpeech: number[] = []): GoldCall {
  return {
    call: 'call9',
    callId: 'call-9',
    units: 'ms',
    offsetMs: 0,
    audio: 'call9-caller.wav',
    method: 'test',
    alignment: { offsetMs: 0, matched: 0, turns: 0, medianErrorMs: 0 },
    segmentation: {},
    needsFounderReview: [],
    nonSpeech: nonSpeech.map(region),
    utterances: utterances.map((utterance, index) => ({
      ...region(index),
      text: '',
      language: 'en',
      thought: `t${index + 1}`,
      expectsReply: true,
      confidence: 'high',
      reasoning: 'test',
      ...utterance,
    })),
  };
}

describe('streaming a call through a configuration', () => {
  it('commits where the VAD stopped and records each final, its timing and reported language', async () => {
    const net = createFixtureNet(
      scribeScript([
        { say: "Hey Maya, what's your real name?", language: 'eng' },
        { say: 'Ah, aber, äh, war noch nicht.', language: 'deu' },
      ]),
    );
    const tap: { onMessage?: (raw: string) => void } = {};
    const recording = await streamCall({
      config: 'scribe-auto',
      call: 'call9',
      model: 'scribe_v2_realtime',
      language: 'en-IN',
      stt: configById('scribe-auto').create!(
        tapNet(net, (raw) => tap.onMessage?.(raw)),
        'fixture-key',
      ),
      utterances: [window('c9-u01', 1), window('c9-u02', 2)],
      tap,
      pace: false,
      maxWaitMs: 1_000,
    });
    expect(recording.error).toBeUndefined();
    const [first, second] = recording.utterances;
    expect(finalText(first!)).toBe("Hey Maya, what's your real name?");
    expect(finalText(second!)).toBe('Ah, aber, äh, war noch nicht.');
    expect(first!.languages).toEqual(['eng']);
    expect(second!.languages).toEqual(['deu']);
    // Speech ends 800 ms in; the commit goes out 200 ms later, on the audio clock.
    expect(first!.commitsAtMs).toEqual([first!.startMs + 1_000]);
    expect(first!.speechEndMs).toBe(first!.startMs + 800);
    expect(recording.usage).toEqual([
      { unit: 'audio_seconds', quantity: expect.any(String), state: 'estimated' },
    ]);
    expect(recording.streamedMs).toBeGreaterThanOrEqual(2 * 1_000);

    const summary = summarize(
      configById('scribe-auto'),
      [
        gold([
          { text: "Hey Maya, what's your real name?" },
          { text: "Ah, I haven't, not yet.", confidence: 'low' },
        ]),
      ],
      [recording],
    );
    // The low-confidence gold is transcribed and checked for its language, but not scored.
    expect(summary).toMatchObject({
      utterances: 1,
      lowConfidence: 1,
      missing: 0,
      misdetected: 1,
      reportedForeign: 1,
      empty: 0,
      noFinal: 0,
    });
    expect(summary.scores[1]!.misdetection).toEqual([
      'letter ä',
      'words aber, noch, nicht',
      'provider reported deu',
    ]);
    expect(summary.scores[0]!.wordErrors).toBe(0);
    expect(summary.timeToFinalP50Ms).not.toBeNull();
    // Scribe bills the audio sent, keyterms included.
    expect(summary.runCostUsd).toBeCloseTo((recording.streamedMs / 3_600_000) * 0.47);
    expect(formatReport({ summaries: [summary], configs: [], golds: [] })).toMatch(
      /\| scribe-auto \| 1\/1 \| 0\.0% \| /,
    );
    net.assertComplete();
  });

  it('records a session that never started instead of throwing', async () => {
    const net = createFixtureNet([]);
    const recording = await streamCall({
      config: 'scribe-en',
      call: 'call9',
      model: 'scribe_v2_realtime',
      language: 'en-IN',
      stt: configById('scribe-en').create!(net, 'fixture-key'),
      utterances: [window('c9-u01', 1)],
      pace: false,
    });
    expect(recording.error).toBeTruthy();
    expect(recording.utterances).toEqual([]);
    const summary = summarize(configById('scribe-en'), [gold([{ text: 'hello' }])], [recording]);
    expect(summary).toMatchObject({ utterances: 1, missing: 1 });
  });
});

describe('scoring', () => {
  it('counts words heard in non-speech as insertions, not word errors', () => {
    const recording = {
      config: 'aai-english',
      call: 'call9',
      model: 'universal-streaming-english',
      language: 'en-IN',
      recordedAt: '',
      streamedMs: 60_000,
      sessionMs: 120_000,
      usage: [],
      utterances: [
        {
          id: 'c9-u01',
          startMs: 0,
          speechEndMs: 800,
          commitsAtMs: [1_000],
          languages: [],
          events: [
            { atMs: 500, kind: 'partial' as const, segmentId: '0', text: 'bueno' },
            { atMs: 1_400, kind: 'final' as const, segmentId: '0', text: 'Bueno, buenas tardes.' },
          ],
        },
      ],
    };
    const summary = summarize(configById('aai-english'), [gold([], [0])], [recording]);
    expect(summary).toMatchObject({
      utterances: 0,
      insertions: 3,
      misdetected: 1,
      reportedForeign: 0,
      wer: 0,
    });
    // AssemblyAI bills the session, not the audio.
    expect(summary.billedSeconds).toBe(120);
  });

  it('scores Hinglish the way the call-eval harness does, whichever script the STT wrote', () => {
    const said = gold([
      {
        text: 'Mera naam hai Tejas.',
        devanagari: 'मेरा नाम है तेजस।',
        language: 'hi',
      },
    ]).utterances[0]!;
    const heard = (text: string) => ({
      id: said.id,
      startMs: 0,
      speechEndMs: 800,
      commitsAtMs: [1_000],
      languages: [],
      events: [{ atMs: 1_200, kind: 'final' as const, segmentId: '0', text }],
    });
    // Mixed script, as Scribe pinned to English writes it, is right word for word.
    expect(scoreUtterance('call9', said, heard('मेरा naam है Tejas'))).toMatchObject({
      wordErrors: 0,
      words: 4,
    });
    // Call 8's "तेज इजाफा" for "Tejas": one word wrong, one extra.
    expect(scoreUtterance('call9', said, heard('मेरा नाम है तेज इजाफा'))).toMatchObject({
      wordErrors: 2,
      words: 4,
      timeToFinalMs: 400,
    });
  });

  it('pools a call into one WER so a late final is not charged to two utterances', () => {
    const recording = {
      config: 'aai-english',
      call: 'call9',
      model: 'universal-streaming-english',
      language: 'en-IN',
      recordedAt: '',
      streamedMs: 2_000,
      sessionMs: 2_000,
      usage: [],
      utterances: ['what do you think about', 'this itinerary'].map((text, index) => ({
        id: `c9-u0${index + 1}`,
        startMs: index * 10_000,
        speechEndMs: index * 10_000 + 800,
        commitsAtMs: [index * 10_000 + 1_000],
        languages: [],
        events: [{ atMs: index * 10_000 + 1_100, kind: 'final' as const, segmentId: '0', text }],
      })),
    };
    const summary = summarize(
      configById('aai-english'),
      [gold([{ text: 'What do you think about this' }, { text: 'itinerary?' }])],
      [recording],
    );
    // Per utterance, "this" is missing from one and extra in the other; over the call, nothing is.
    expect(summary.wer).toBeCloseTo(2 / 7);
    expect(summary.callWer).toBe(0);
    expect(summary.werEnglish).toBeCloseTo(2 / 7);
    expect(summary.werHindi).toBeNull();
  });

  it('counts a partial that never finalised as heard, for regions without words', () => {
    const events = [
      { atMs: 100, kind: 'partial' as const, segmentId: '0', text: 'Question' },
      { atMs: 300, kind: 'partial' as const, segmentId: '0', text: 'Question 4.' },
      { atMs: 900, kind: 'partial' as const, segmentId: '1', text: 'Hi' },
      { atMs: 1_000, kind: 'final' as const, segmentId: '1', text: 'Hıhı.' },
      { atMs: 1_100, kind: 'partial' as const, segmentId: '1', text: 'stale' },
    ];
    expect(heardText({ events })).toBe('Question 4. Hıhı.');
    expect(finalText({ events })).toBe('Hıhı.');
  });

  it('reads the language each provider reports', () => {
    expect(
      reportedLanguage(
        '{"message_type":"committed_transcript_with_timestamps","language_code":"tr"}',
      ),
    ).toBe('tr');
    expect(reportedLanguage('{"type":"data","data":{"language_code":"hi-IN"}}')).toBe('hi-IN');
    expect(reportedLanguage('{"channel":{"alternatives":[{"languages":["de"]}]}}')).toBe('de');
    expect(reportedLanguage('not json')).toBeUndefined();
  });
});

describe('the configurations', () => {
  it('have unique ids and cite the docs that confirm their options', () => {
    expect(new Set(STT_CONFIGS.map((config) => config.id)).size).toBe(STT_CONFIGS.length);
    for (const config of STT_CONFIGS) {
      expect(config.docs.length).toBeGreaterThan(0);
      for (const doc of config.docs) {
        expect(doc.url).toMatch(/^https:\/\//);
        expect(doc.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(config.price.usdPerHour).toBeGreaterThan(0);
    }
    expect(STT_CONFIGS.filter((config) => config.production).map((config) => config.id)).toEqual([
      'scribe-auto',
    ]);
  });

  it('are pending until both a plugin and a key exist', () => {
    expect(configStatus(configById('scribe-auto'), { ELEVENLABS_API_KEY: 'k' })).toBe('ready');
    expect(configStatus(configById('deepgram-nova3-multi'), {})).toBe('pending key');
    expect(configStatus(configById('cartesia-ink2'), { CARTESIA_API_KEY: 'k' })).toBe(
      'pending plugin',
    );
    expect(() => configById('nope')).toThrow('unknown STT config nope');
  });
});
