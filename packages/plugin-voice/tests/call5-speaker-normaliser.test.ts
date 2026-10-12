import { describe, expect, it } from 'vitest';
import type { TextFilter } from '@winsendotai/ovo-contracts';
import {
  BoundedSpeechScheduler,
  createSpeechNormaliserFilter,
  indianVerbalisationFilter,
  markdownFilter,
  SPEECH_NORMALISER_FILTER_ID,
  speakerTextFilters,
} from '../src/index.ts';

/**
 * Wave 9 D1, call 10d5ef30: Maya's release selected no text filters, so it spoke through the
 * distribution defaults (markdown and Indian verbalisation), and so does every release pinned
 * before the normaliser existed. The speaker adds the normaliser itself: no agent can be left
 * reading "December 21–January 5" or "₹70,000–₹1,00,000" as written.
 */
const WAVE8_DEFAULTS: TextFilter[] = [markdownFilter, indianVerbalisationFilter];

async function spokenBy(filters: readonly TextFilter[], text: string, language = 'en-IN') {
  const spoken: string[] = [];
  const scheduler = new BoundedSpeechScheduler({
    async play(segment) {
      spoken.push(segment.text);
      return { state: 'completed', evidence: 'simulated' };
    },
    async interrupt() {},
  });
  scheduler.configureFilters(filters, language);
  await scheduler.speak(text);
  return spoken[0];
}

describe('call 10d5ef30 D1: the speaker normalises every agent', () => {
  it('writes turn 8 for the ear through the Wave 8 default filters', async () => {
    // Turn 8's reply without its years, so the result does not depend on today's date.
    const reply =
      'For Chennai–Prague, December 21–January 5, a rough budget of ₹70,000–₹1,00,000 per person is sensible.';
    expect(await spokenBy(WAVE8_DEFAULTS, reply)).toBe(
      'For Chennai to Prague, the 21st of December to the 5th of January, a rough budget of between seventy thousand rupees and one lakh rupees per person is sensible.',
    );
  });

  it('normalises with no filters configured at all', async () => {
    expect(await spokenBy([], 'Open 10am–2pm, Monday–Friday.', 'en-US')).toBe(
      'Open 10am to 2pm, Monday to Friday.',
    );
  });

  it('adds the normaliser once, and keeps an agent’s own instance of it', () => {
    const own = createSpeechNormaliserFilter({ now: () => 0 });
    expect(speakerTextFilters(WAVE8_DEFAULTS).map((filter) => filter.id)).toEqual([
      ...WAVE8_DEFAULTS.map((filter) => filter.id),
      SPEECH_NORMALISER_FILTER_ID,
    ]);
    expect(speakerTextFilters([markdownFilter, own])).toEqual([markdownFilter, own]);
  });

  it('leaves Hindi text alone', async () => {
    expect(await spokenBy(WAVE8_DEFAULTS, 'दिसंबर 21–जनवरी 5', 'hi-IN')).toBe('दिसंबर 21–जनवरी 5');
  });
});
