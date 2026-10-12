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
