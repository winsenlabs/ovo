import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import {
  filterSpeechText,
  indianVerbalisationFilter,
  markdownFilter,
  speakerTextFilters,
  urlFilter,
} from '../../plugin-voice/src/speech/text-filters.ts';
import { spokenText } from '../src/binding.ts';
import { FIXTURE_KEY, generationSteps, mintSteps, socketOpen } from '../src/testing.ts';
import { RumikTts } from '../src/tts.ts';
import { drain, script, ttsInput } from './support.ts';

const MUGA = { model: 'muga' as const };

describe('R6: muga tone tags and inline events', () => {
  it('prefixes the default tone only when the text does not lead with one of the six tags', () => {
    expect(spokenText(MUGA, 'Haan ji, bataiye.')).toBe('[neutral] Haan ji, bataiye.');
    expect(spokenText({ ...MUGA, defaultTone: 'happy' }, 'Haan ji!')).toBe('[happy] Haan ji!');
    expect(spokenText(MUGA, '[excited] Aapko reward mila!')).toBe('[excited] Aapko reward mila!');
    // The tag must be the first token, so leading whitespace goes; nothing else changes.
    expect(spokenText(MUGA, '  [sad] Oh.')).toBe('[sad] Oh.');
    // Anything that is not one of the six lowercase tags is text, and gets the default tone.
    expect(spokenText(MUGA, '[Happy] Hi.')).toBe('[neutral] [Happy] Hi.');
    expect(spokenText(MUGA, '[1] Hi.')).toBe('[neutral] [1] Hi.');
  });

  it('keeps inline <events> and later tags exactly where they stand', () => {
    expect(spokenText(MUGA, '<laugh> Yaar tumne phir wahi joke maara!')).toBe(
      '[neutral] <laugh> Yaar tumne phir wahi joke maara!',
    );
    expect(spokenText(MUGA, '[happy] <laugh> <laugh> Kya baat hai! <chuckle>')).toBe(
      '[happy] <laugh> <laugh> Kya baat hai! <chuckle>',
    );
    expect(spokenText(MUGA, '[whisper] Suno.\n\n[sad] <sigh> Chalo.')).toBe(
      '[whisper] Suno.\n\n[sad] <sigh> Chalo.',
    );
  });

  it('leaves mulberry text alone: mulberry has no tone tags', () => {
    expect(spokenText({ description: 'd' }, 'Haan ji.')).toBe('Haan ji.');
    expect(spokenText({ description: 'd', defaultTone: 'happy' }, '<laugh> Haan.')).toBe(
      '<laugh> Haan.',
    );
  });

  it('mints muga and sends the tagged text, without a description or speaker', async () => {
    const text = '<laugh> Haan ji, bilkul!';
    const net = createFixtureNet([
      script([
        ...mintSteps(MULAW_8K, { model: 'muga' }),
        socketOpen(),
        ...generationSteps(`[happy] ${text}`, MULAW_8K, 1, { normalization: false }),
      ]),
    ]);
    const tts = new RumikTts(net, FIXTURE_KEY, {
      ...MUGA,
      defaultTone: 'happy',
      description: 'not for muga',
      speaker: 'ira',
      temperature: 0.7,
    });
    await drain(tts.synthesize(ttsInput([], { text })));
    const frame = JSON.parse(String(net.log.find((entry) => entry.kind === 'ws-out')!.data));
    expect(frame).toEqual({ text: `[happy] ${text}`, temperature: 0.7, normalization: false });
    net.assertComplete();
  });
});

/**
 * R6 report (no change outside this lane): what OVO's speaker text filters do today to muga tags
 * before they reach this plugin. The filter list is the one every speaker applies
 * (`speakerTextFilters` adds the speech normaliser); the markdown, URL and Indian verbalisation
 * filters are the optional ones an agent may select. Findings, 2026-10-13:
 * - `[tone]` tags and `<laugh>`/`<chuckle>`/`<sigh>` events pass through every filter unchanged;
 * - a bracketed number such as `[2]` is removed by the markdown filter (`dropSpokenCitations`),
 *   which is the intended citation stripping and touches no tone tag;
 * - the Indian verbalisation filter rewrites figures (`4,850` becomes words) and leaves tags alone.
 * Not covered by a filter and still open for W12: OVO splits a reply into sentences before TTS, so
 * only the first sentence keeps an LLM-written leading `[tone]`; later sentences get `defaultTone`.
 */
describe('R6 report: OVO text filters and muga tags', () => {
  const all = speakerTextFilters([markdownFilter, urlFilter, indianVerbalisationFilter]);
  const always = speakerTextFilters([]);
  const run = (text: string, language = 'hi-IN') => ({
    always: filterSpeechText(always, text, language),
    all: filterSpeechText(all, text, language),
  });

  it('passes tone tags and inline events through unchanged', () => {
    for (const text of [
      '[neutral] Theek hai.',
      '[whisper] <sigh> Aaj ka din lamba tha.',
      'Kya baat hai <laugh> <laugh> yaar!',
    ])
      expect(run(text)).toEqual({ always: text, all: text });
  });

  it('verbalises figures around the tags, and keeps the tags', () => {
    expect(run('[happy] <laugh> Aapka EMI 4,850 rupees hai.', 'en-IN')).toEqual({
      always: '[happy] <laugh> Aapka EMI 4,850 rupees hai.',
      all: '[happy] <laugh> Aapka EMI four thousand eight hundred and fifty rupees hai.',
    });
  });

  it('drops a bracketed citation number, which is not a tone tag', () => {
    expect(run('[happy] [2] Haan.')).toEqual({ always: '[happy] [2] Haan.', all: '[happy] Haan.' });
  });
});
