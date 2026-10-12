import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unclearForSearch } from '../src/search-voice.ts';

interface LiveTurn {
  turn: string;
  caller: string;
  agentBefore: string | null;
  searchMs: number | null;
}

const LIVE = JSON.parse(
  readFileSync(new URL('./fixtures/call-e8a43f65-turns.json', import.meta.url), 'utf8'),
) as { turns: LiveTurn[] };

const guard = ({ caller, agentBefore }: Pick<LiveTurn, 'caller' | 'agentBefore'>) =>
  unclearForSearch({
    input: caller,
    history: agentBefore ? [{ role: 'assistant', content: agentBefore }] : [],
  });

describe('no web search on statements of plans, dates or lists (call e8a43f65, issue 3)', () => {
  it('replays every request of the call', () => {
    expect(LIVE.turns.map((turn) => [turn.turn, guard(turn)])).toEqual([
      ['turn-1', 'statement'],
      ['turn-2', 'statement'],
      ['turn-3', 'statement'],
      ['turn-4', 'statement'],
      ['turn-5', 'statement'],
      ['turn-6', 'statement'],
      // Asks nothing to look up either way; left to the model, which did not search.
      ['turn-7', undefined],
    ]);
  });

  it('removes every search the call ran: 12.2 s of searching, and the answers that waited', () => {
    const searched = LIVE.turns.filter((turn) => turn.searchMs !== null);
    expect(searched.filter((turn) => guard(turn) === undefined)).toEqual([]);
    expect(searched.reduce((sum, turn) => sum + turn.searchMs!, 0)).toBe(12_185);
  });

  it('keeps no search for the words as Wave 8b merges them, a list continued included', () => {
    const before = LIVE.turns[3]!.agentBefore;
    for (const caller of [
      "Yeah, we're planning to do Budapest, Vienna, in Austria. Then we're planning to go to Zagreb, Prague.",
      "Yeah, we're planning to do Budapest, Vienna, in Austria. Then we're planning to go to Zagreb, Prague. Germany, Berlin, and a few other places.",
      'Germany, Berlin, and a few other places.',
      'December 21st to January 5th.',
      "Yes, that's right.",
    ])
      expect(guard({ caller, agentBefore: before }), caller).toBe('statement');
  });

  it('still searches when the caller asks, or answers the agent’s offer to look something up', () => {
    const before = 'Budapest and Vienna would fit nicely with Zagreb.';
    for (const caller of [
      "We're planning to go to Zagreb in December. What's the weather like?",
      'I want to know the train times from Vienna to Budapest.',
      'Is the Christmas market open on the 25th?',
      'Germany, Berlin, and a few other places. Which is cheapest?',
    ])
      expect(guard({ caller, agentBefore: before }), caller).toBeUndefined();
    expect(
      guard({
        caller: "We'd like to leave on the 21st of December.",
        agentBefore: 'Tell me your dates and I can check the train fares.',
      }),
    ).toBeUndefined();
  });
});
