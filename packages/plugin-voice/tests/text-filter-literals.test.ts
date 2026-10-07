import { describe, expect, it } from 'vitest';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { markdownFilter, urlFilter } from '../src/speech/text-filters.ts';

describe('speech filter literal fidelity', () => {
  it('preserves literal punctuation in email, URL destinations and inline identifiers', async () => {
    const seen: string[] = [];
    const speech = new BoundedSpeechScheduler({
      async play(segment) {
        seen.push(segment.text);
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    });
    speech.configureFilters([urlFilter, markdownFilter], 'en-US');
    const expected =
      'Contact user_name at example dot com via example dot com slash ~alice slash *reset_token?request_id=a_b with snake_case and code_name';
    try {
      const receipt = await speech.speak(
        '**Contact** user_name@example.com via https://example.com/~alice/*reset_token?request_id=a_b with snake_case and `code_name`',
      );
      expect(seen).toEqual([expected]);
      expect(receipt.text).toBe(expected);
    } finally {
      await speech.dispose();
    }
  });

  it('still strips underscore emphasis at word boundaries', () => {
    expect(markdownFilter.apply('_a_ __bold__ and _some words_.', { language: 'en-US' })).toBe(
      'a bold and some words.',
    );
  });

  it('strips surrounding formatting without changing literal address punctuation', () => {
    expect(
      markdownFilter.apply('**https://example.com/~alice** and `_user_@example.com`', {
        language: 'en-US',
      }),
    ).toBe('https://example.com/~alice and _user_@example.com');
  });

  it('drops web search citations whole and keeps ordinary links as their text', () => {
    expect(
      markdownFilter.apply(
        'Sunny today ([weather.com](https://weather.com/a?utm_source=openai), [imd.gov.in](https://imd.gov.in/x)). Rain tonight【3†source】 [1][2]. Ask [the desk](https://a.com/desk).',
        { language: 'en-US' },
      ),
    ).toBe('Sunny today. Rain tonight. Ask the desk.');
    // Brackets in ordinary speech are left alone.
    expect(markdownFilter.apply('Two (maybe three) [roughly] came.', { language: 'en-US' })).toBe(
      'Two (maybe three) [roughly] came.',
    );
  });
});
