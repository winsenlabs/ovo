import { describe, expect, it } from 'vitest';
import { unclearForSearch } from '../src/search-voice.ts';

const guard = (agentBefore: string, caller: string) =>
  unclearForSearch({ input: caller, history: [{ role: 'assistant', content: agentBefore }] });

/**
 * Wave 9 D7, Maya call 10d5ef30. Requests that carried the web search tool and did not search
 * (5,385–5,539 input tokens) took 1,295–2,762 ms; those without it (830–1,092 tokens) took
 * 1,206–1,956 ms. A yes to the platform's "Shall I end the call?" has nothing to look up.
 */
describe('no search tool for a yes to ending the call (call 10d5ef30 turn 23)', () => {
  it('turn 23: "Yeah, yeah, please." to "One moment. Shall I end the call?"', () => {
    expect(guard('One moment. Shall I end the call?', 'Yeah, yeah, please.')).toBe('backchannel');
    expect(guard('Shall I hang up?', 'Yes.')).toBe('backchannel');
  });

  it('keeps the tool for a yes to any offer the line also makes', () => {
    // Turn 21: the agent offered to draft an email; a yes to an offer is left to the model.
    expect(
      guard(
        'One moment. I can’t send emails from this call, but I can put the itinerary into a ready-to-copy email for you. Would you like me to draft it?',
        'Yeah, yeah, sure.',
      ),
    ).toBeUndefined();
    expect(guard('Shall I check the fares, or shall I end the call?', 'Yes.')).toBeUndefined();
    expect(guard('Shall I look up the train times?', 'Yes, please.')).toBeUndefined();
  });

  it('keeps it for a question after the ending offer', () => {
    expect(
      guard('Shall I end the call?', 'Actually, what is the weather in Prague?'),
    ).toBeUndefined();
  });
});

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
