import { describe, expect, it } from 'vitest';
import { unclearForSearch } from '../src/search-voice.ts';

/**
 * Wave 9, issue D8: Maya call 10d5ef30 (2026-10-12). No request searched twice: each billed at most
 * one `web_search_calls` (the call's usage events), turn 17's included. The second search in turn
 * 17's summary is the LLM asked ahead on turn 18's first partial, "Yeah, dude." (request
 * `openai:aborted:11`, 247.73–249.12 s, one search billed): aborted before turn 18's decision, it
 * was timed against turn 17, the telemetry's active turn. Turn 18's own request then searched again.
 * The partial asks nothing to look up.
 */
describe('no web search on a yes with a word of address (call 10d5ef30, D8)', () => {
  const history = [
    { role: 'assistant' as const, content: 'You’re right—you already said that.' },
    { role: 'assistant' as const, content: 'Want more detail?' },
  ];

  it('leaves the search out for turn 18’s first partial, and in for its final words', () => {
    expect(unclearForSearch({ input: 'Yeah, dude.', history })).toBe('backchannel');
    expect(
      unclearForSearch({ input: "Yeah, dude. That's why I'm asking.", history }),
    ).toBeUndefined();
  });

  it('still searches on a yes to an offer to look something up', () => {
    const offered = [{ role: 'assistant' as const, content: 'Shall I check the flights?' }];
    expect(unclearForSearch({ input: 'Yeah, dude.', history: offered })).toBeUndefined();
  });
});
