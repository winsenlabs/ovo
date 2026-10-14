import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createFixtureNet } from '../../../../plugin-kit/src/index.ts';
import {
  GAP_MS,
  assemblyAiBatch,
  compress,
  multipart,
  scribeBatch,
  wordsByUtterance,
} from '../batch.ts';
import { GOLD_DIR, loadGolds } from '../cli.ts';
import { allRegions, goldReferences, parseGold, spokenLanguages } from '../gold.ts';
import type { Pcm } from '../wav.ts';

const pcm = (ms: number, value = 100): Pcm => ({
  sampleRate: 8000,
  samples: new Int16Array(ms * 8).fill(value),
});

function utterance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c9-u01',
    startMs: 0,
    endMs: 1_000,
    audioStartMs: 500,
    audioEndMs: 1_500,
    text: 'mera naam hai Tejas',
    devanagari: 'मेरा नाम है Tejas',
    language: 'mixed',
    thought: 't01',
    expectsReply: true,
    confidence: 'medium',
    reasoning: 'test',
    productionTurnIds: [],
    productionText: '',
    candidates: {},
    note: '',
    ...overrides,
  };
}

describe('gold files', () => {
  const file = (utterances: unknown[], extra: Record<string, unknown> = {}) => ({
    call: 'call9',
    utterances,
    nonSpeech: [],
    needsFounderReview: [],
    ...extra,
  });

  it('accept both scripts of a Hinglish utterance as references', () => {
    const gold = parseGold(
      file([utterance({ accept: ['mera nam hai Tejas'] })], { needsFounderReview: ['c9-u01'] }),
    );
    expect(goldReferences(gold.utterances[0]!)).toEqual([
      'mera naam hai Tejas',
      'मेरा नाम है Tejas',
      'mera nam hai Tejas',
    ]);
    expect(spokenLanguages(gold.utterances[0]!)).toEqual(['en', 'hi']);
  });

  it('refuse a malformed file, naming the field', () => {
    expect(() => parseGold(file([utterance({ devanagari: undefined })]))).toThrow(
      'is mixed but has no devanagari form',
    );
    expect(() => parseGold(file([utterance({ text: 'मेरा नाम' })]))).toThrow(
      'text must be romanised',
    );
    expect(() =>
      parseGold(file([utterance(), utterance({ id: 'c9-u02', startMs: 500, endMs: 2_000 })])),
    ).toThrow('c9-u02 overlaps c9-u01');
    expect(() => parseGold(file([utterance({ text: '' })]))).toThrow('belongs in nonSpeech');
    expect(() => parseGold(file([utterance({ thought: 3 })]))).toThrow('thought is missing');
    expect(() => parseGold(file([utterance()], { needsFounderReview: ['c9-u07'] }))).toThrow(
      'needsFounderReview names unknown utterance c9-u07',
    );
    expect(() => parseGold({ call: 'call9', utterances: [] })).toThrow('nonSpeech is missing');
  });

  it('are committed for calls 7 and 8, reconciled, with every candidate', async () => {
    const golds = await loadGolds();
    expect(golds.map((gold) => gold.call)).toEqual(['call7', 'call8']);
    for (const gold of golds) {
      expect(gold.method).not.toMatch(/^draft/);
      expect(gold.alignment.medianErrorMs).toBeLessThanOrEqual(100);
      expect(gold.offsetMs).toBe(gold.alignment.offsetMs);
      for (const region of allRegions(gold))
        expect(Object.keys(region.candidates).length).toBeGreaterThanOrEqual(8);
      for (const utterance of gold.utterances) expect(utterance.reasoning).toBeTruthy();
      for (const region of gold.nonSpeech) expect(region.note).not.toMatch(/^draft/);
    }
    expect(GOLD_DIR).toMatch(/corpus\/gold$/);
    expect(JSON.parse(await readFile(`${GOLD_DIR}/call8.json`, 'utf8')).callId).toBe(
      'eb509d62-3e43-4cfd-aee0-eb0680cdef0e',
    );
  });
});

describe('batch second opinions', () => {
  it('join utterances with a gap and give each word back to its utterance', () => {
    const joined = compress([
      { id: 'a', pcm: pcm(500) },
      { id: 'b', pcm: pcm(800) },
    ]);
    expect(joined.offsetsMs).toEqual([0, 500 + GAP_MS]);
    expect(joined.pcm.samples.length).toBe((500 + 800 + 2 * GAP_MS) * 8);
    expect(
      wordsByUtterance(
        [
          { text: 'hey', startMs: 10, endMs: 200 },
          { text: 'Maya', startMs: 300, endMs: 480 },
          { text: 'Zagreb', startMs: 1_600, endMs: 2_000 },
          { text: 'stray', startMs: 9_000, endMs: 9_100 },
        ],
        joined.offsetsMs,
        joined.lengthsMs,
      ),
    ).toEqual(['hey Maya', 'Zagreb']);
  });

  it('send Scribe a multipart upload and keep only its words', async () => {
    const net = createFixtureNet([
      {
        host: 'api.elevenlabs.io',
        source: 'https://elevenlabs.io/docs/api-reference/speech-to-text/convert',
        retrieved: '2026-10-14',
        steps: [
          {
            expect: 'http',
            method: 'POST',
            url: 'https://api.elevenlabs.io/v1/speech-to-text',
            headers: {
              'xi-api-key': 'fixture-key',
              'content-type': /^multipart\/form-data; boundary=/,
            },
            reply: {
              status: 200,
              body: JSON.stringify({
                language_code: 'eng',
                language_probability: 0.9,
                text: 'Hey Maya',
                words: [
                  { text: 'Hey', start: 0.1, end: 0.3, type: 'word', logprob: -0.1 },
                  { text: ' ', start: 0.3, end: 0.35, type: 'spacing' },
                  { text: 'Maya', start: 0.35, end: 0.7, type: 'word', logprob: -0.2 },
                ],
              }),
            },
          },
        ],
      },
    ]);
    const result = await scribeBatch(net, 'fixture-key', pcm(800), {
      model: 'scribe_v2',
      keyterms: ['Maya'],
    });
    expect(result).toEqual({
      language: 'eng',
      words: [
        { text: 'Hey', startMs: 100, endMs: 300 },
        { text: 'Maya', startMs: 350, endMs: 700 },
      ],
    });
    net.assertComplete();
    const sent = new TextDecoder().decode(
      multipart([['model_id', 'scribe_v2']], { name: 'file', file: new Uint8Array([1, 2]) }).body,
    );
    expect(sent).toMatch(/name="model_id"\r\n\r\nscribe_v2\r\n/);
    expect(sent).toMatch(/name="file"; filename="audio.wav"\r\nContent-Type: audio\/wav/);
  });

  it('upload, submit and poll an AssemblyAI transcript with language detection', async () => {
    const base = 'https://api.assemblyai.com/v2';
    const net = createFixtureNet([
      {
        host: 'api.assemblyai.com',
        source: 'https://www.assemblyai.com/docs/api-reference/transcripts/submit',
        retrieved: '2026-10-14',
        steps: [
          {
            expect: 'http',
            method: 'POST',
            url: `${base}/upload`,
            headers: { authorization: 'fixture-key' },
            reply: { status: 200, body: JSON.stringify({ upload_url: 'https://cdn.example/u1' }) },
          },
          {
            expect: 'http',
            method: 'POST',
            url: `${base}/transcript`,
            body: 'json',
            where: { audio_url: 'https://cdn.example/u1', language_detection: true },
            reply: { status: 200, body: JSON.stringify({ id: 't1', status: 'queued' }) },
          },
          {
            expect: 'http',
            method: 'GET',
            url: `${base}/transcript/t1`,
            reply: { status: 200, body: JSON.stringify({ id: 't1', status: 'processing' }) },
          },
          {
            expect: 'http',
            method: 'GET',
            url: `${base}/transcript/t1`,
            reply: {
              status: 200,
              body: JSON.stringify({
                id: 't1',
                status: 'completed',
                language_code: 'hi',
                words: [{ text: 'haan', start: 100, end: 300, confidence: 0.9 }],
              }),
            },
          },
        ],
      },
    ]);
    expect(await assemblyAiBatch(net, 'fixture-key', pcm(400), { pollMs: 0 })).toEqual({
      language: 'hi',
      words: [{ text: 'haan', startMs: 100, endMs: 300 }],
    });
    net.assertComplete();
  });
});
