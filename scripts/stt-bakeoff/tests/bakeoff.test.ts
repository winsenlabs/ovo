import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MULAW_8K, type NetFixtureScript } from '../../../packages/contracts/src/index.ts';
import { pcm16ToMulaw } from '../../../packages/audio/src/index.ts';
import { speechLikePcm16 } from '../../../packages/conformance/src/drivers/audio-gen.ts';
import { createFixtureNet } from '../../../packages/plugin-kit/src/index.ts';
import { assemblyAiTemplate } from '../../../packages/plugin-stt-assemblyai/src/testing.ts';
import { scribeTemplate } from '../../../packages/plugin-stt-elevenlabs/src/testing.ts';
import { sarvamSttTemplate } from '../../../packages/plugin-speech-sarvam/src/testing.ts';
import { readWav } from '../audio.ts';
import { parseProviders } from '../cli.ts';
import { runBakeoff } from '../run.ts';
import type { PriceTable, ProviderId, Recording } from '../types.ts';
import { bestMatch, normalizeWords, wordErrors } from '../wer.ts';

const FIXTURES = new URL('../fixtures', import.meta.url).pathname;
const prices = JSON.parse(
  await readFile(new URL('../prices.json', import.meta.url), 'utf8'),
) as PriceTable;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('word error rate', () => {
  it('compares words as a transcriber would', () => {
    expect(normalizeWords('Haan, ₹4,210 — by FRIDAY!')).toEqual(['haan', '4210', 'by', 'friday']);
    expect(normalizeWords('हाँ, मैं कल तक।')).toEqual(['हाँ', 'मैं', 'कल', 'तक']);
    expect(wordErrors(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2);
    expect(wordErrors(['a', 'b'], [])).toBe(2);
  });

  it('scores against the closest accepted spelling', () => {
    expect(bestMatch(['haan main kal', 'हाँ मैं कल'], 'हाँ मैं कल')).toEqual({
      errors: 0,
      words: 3,
    });
    expect(bestMatch(['haan main kal'], 'haan kal')).toEqual({ errors: 1, words: 3 });
  });
});

describe('the offline bake-off on the committed corpus', () => {
  it('scores every provider and labels the synthetic data', async () => {
    const { summaries, report } = await runBakeoff({
      corpusDir: FIXTURES,
      providers: ['scribe', 'assemblyai', 'sarvam'],
      usdInr: 88,
      prices,
    });
    const byId = Object.fromEntries(summaries.map((summary) => [summary.provider, summary]));
    expect(byId.scribe).toMatchObject({ utterances: 4, failures: 0, wer: 0 });
    // 1 error in 8 words and 1 in 7, over 31 reference words.
    expect(byId.assemblyai!.wer).toBeCloseTo(2 / 31);
    expect(byId.assemblyai!.werByStyle).toMatchObject({ 'indian-english': 0 });
    expect(byId.scribe!.firstPartialP50Ms).toBe(320);
    expect(byId.scribe!.finalLatencyP95Ms).toBe(270);
    // Sarvam's INR price applies unconverted; the others convert at the given rate.
    expect(byId.sarvam!.inrPerAudioHour).toBeGreaterThan(30);
    expect(byId.assemblyai!.inrPerAudioHour).toBeGreaterThan(0.15 * 88);
    expect(report).toContain('SYNTHETIC DATA: these numbers measure nothing');
    expect(report).toMatch(/\| scribe \| scribe_v2_realtime \| 4 \| 0 \| 0\.0% \|/);
  });

  it('reports an unpriced meter instead of inventing a cost', async () => {
    const { summaries } = await runBakeoff({
      corpusDir: FIXTURES,
      providers: ['scribe'],
      usdInr: 88,
      prices: {},
    });
    expect(summaries[0]!.inrPerAudioHour).toBeNull();
    expect(() => parseProviders('scribe,deepgram')).toThrow('unknown provider deepgram');
    expect(parseProviders(undefined)).toEqual(['scribe', 'assemblyai', 'sarvam']);
  });
});

/** A corpus of one 8 kHz mu-law WAV utterance in a temporary directory. */
async function liveCorpus(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ovo-bakeoff-'));
  dirs.push(dir);
  const samples = pcm16ToMulaw(speechLikePcm16({ seed: 3, ms: 600, rate: 8_000 }));
  const wav = new Uint8Array(58 + samples.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, text: string) => wav.set(new TextEncoder().encode(text), at);
  ascii(0, 'RIFF');
  view.setUint32(4, wav.byteLength - 8, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 18, true);
  view.setUint16(20, 7, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(38, 'fact');
  view.setUint32(42, 4, true);
  view.setUint32(46, samples.byteLength, true);
  ascii(50, 'data');
  view.setUint32(54, samples.byteLength, true);
  wav.set(samples, 58);
  await writeFile(join(dir, 'hello.wav'), wav);
  await writeFile(
    join(dir, 'corpus.json'),
    JSON.stringify({
      utterances: [
        {
          id: 'hello',
          language: 'hi-IN',
          style: 'hinglish',
          reference: 'haan ji bol rahe hain',
          audio: 'hello.wav',
        },
      ],
    }),
  );
  return dir;
}

/** Each provider's own documented fixture for the utterance, with the bake-off's binding host. */
function scripts(provider: ProviderId, say: string): NetFixtureScript[] {
  const input = {
    format: MULAW_8K,
    language: 'hi-IN',
    sessionId: 'bakeoff-hello',
    turns: [{ atMs: 0, say }],
  };
  if (provider === 'scribe') return scribeTemplate(input);
  if (provider === 'sarvam') return sarvamSttTemplate(input);
  return assemblyAiTemplate(input).map((script) => ({
    ...script,
    host: 'streaming.us.assemblyai.com',
    steps: script.steps.map((step) =>
      'expect' in step && step.expect === 'ws-open'
        ? { ...step, url: /^wss:\/\/streaming\.us\.assemblyai\.com\/v3\/ws\?/ }
        : 'send' in step && typeof step.send === 'string'
          ? { ...step, send: step.send.replace('universal-streaming-english', 'universal-3-6-pro') }
          : step,
    ),
  }));
}

describe('live mode', () => {
  it('refuses without every chosen provider key, and without audio', async () => {
    const options = { providers: ['scribe', 'sarvam'] as ProviderId[], usdInr: 88, prices };
    await expect(
      runBakeoff({ ...options, corpusDir: await liveCorpus(), live: true, env: {} }),
    ).rejects.toThrow(
      '--live needs OVO_BAKEOFF_ELEVENLABS_API_KEY, OVO_BAKEOFF_SARVAM_API_KEY (refusing to run)',
    );
    await expect(
      runBakeoff({
        ...options,
        corpusDir: FIXTURES,
        live: true,
        env: { OVO_BAKEOFF_ELEVENLABS_API_KEY: 'k', OVO_BAKEOFF_SARVAM_API_KEY: 'k' },
      }),
    ).rejects.toThrow('--live needs audio for en-identity');
  });

  it('streams the WAV through each production plugin and saves what came back', async () => {
    const dir = await liveCorpus();
    const say = 'haan ji bol rahe hain';
    const nets = new Map<ProviderId, ReturnType<typeof createFixtureNet>>();
    const { summaries } = await runBakeoff({
      corpusDir: dir,
      providers: ['scribe', 'assemblyai', 'sarvam'],
      live: true,
      usdInr: 88,
      prices,
      pace: false,
      env: {
        OVO_BAKEOFF_ELEVENLABS_API_KEY: 'fixture-key',
        OVO_BAKEOFF_ASSEMBLYAI_API_KEY: 'fixture-key',
        OVO_BAKEOFF_SARVAM_API_KEY: 'fixture-key',
      },
      net: (provider) => {
        const net = createFixtureNet(scripts(provider, say));
        nets.set(provider, net);
        return net;
      },
    });
    for (const summary of summaries) {
      expect(summary, summary.provider).toMatchObject({ utterances: 1, failures: 0, wer: 0 });
      expect(summary.scores[0]!.hypothesis).toBe(say);
      expect(summary.firstPartialP50Ms).not.toBeNull();
    }
    for (const [provider, net] of nets) expect(net.mismatches, provider).toEqual([]);
    const saved = JSON.parse(
      await readFile(join(dir, 'recordings', 'scribe', 'hello.json'), 'utf8'),
    ) as Recording;
    expect(saved).toMatchObject({ provider: 'scribe', utteranceId: 'hello', language: 'hi-IN' });
    expect(saved.synthetic).toBeUndefined();
    expect(saved.usage[0]).toMatchObject({ unit: 'audio_seconds' });
    expect(readWav(new Uint8Array(await readFile(join(dir, 'hello.wav')))).format).toEqual(
      MULAW_8K,
    );
  });
});
