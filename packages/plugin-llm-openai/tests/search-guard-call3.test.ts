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
  readFileSync(new URL('./fixtures/call-6e1a4e3a-turns.json', import.meta.url), 'utf8'),
) as { turns: LiveTurn[] };

const guard = ({ caller, agentBefore }: LiveTurn) =>
  unclearForSearch({
    input: caller,
    history: agentBefore ? [{ role: 'assistant', content: agentBefore }] : [],
  });

describe('the search tool only for words that ask (call 6e1a4e3a, call-3 #2)', () => {
  it('replays every caller turn of the call', () => {
    const reasons = Object.fromEntries(LIVE.turns.map((turn) => [turn.caller, guard(turn)]));
    expect(reasons).toEqual({
      'हाँ।': 'backchannel',
      'Yeah, yeah, hi, my friend.': 'backchannel',
      'Hello?': 'backchannel',
      "I'm planning to go to Zagreb in Croatia. What do you know about this place?": undefined,
      'Okay. Wait, wait, wait. Tell me, tell me about Zagreb. Hello? Wait, wait, wait, wait, wait. Tell me about the Hamburg as well.':
        undefined,
      'Hmm, okay. So, tell me more about Nuremberg.': undefined,
      'Who are the Nazis?': undefined,
      // A statement goes to the model with the tool: a follow-up often names no question word.
      "Ma'am, they seem like nice people.": undefined,
      // Answers the agent's question ("...or the Nazi leaders in history?"): the model decides.
      'Hardik?': undefined,
      'Hello, if madam...': 'cut-off',
      'Credit. Okay, so...': 'cut-off',
      'Wait. Hold on.': 'backchannel',
      'Listen to me. Listen to me, please.': undefined,
      // Wave 8b: the caller saying where they are asks nothing to look up (it did not search).
      "I'm in a coffee shop.": 'statement',
      'No. Can you check for flights from Chennai to Frankfurt?': undefined,
      'Sometime during Christmas.': undefined,
      "Yeah. So we'd like to leave on the 20th and be back around the 1": undefined,
      'st.': undefined,
      'जानकार, जानकार। एक लाख...': 'cut-off',
      'Two checks, sir, yes. Those dates are correct.': undefined,
      // A yes to "...shall I check the options for two?": the caller asked for the search.
      'Yeah.': undefined,
      'Oh, my God.': 'backchannel',
      'Okay. Thank you, Danny.': 'backchannel',
    });
  });

  it('removes the search that "Oh, my God." ran, and no search a question needed', () => {
    const live = LIVE.turns.filter((turn) => turn.searchMs !== null);
    const dropped = live.filter((turn) => guard(turn) !== undefined);
    expect(dropped.map((turn) => turn.caller)).toEqual(['Oh, my God.']);
    // 1,963 ms of search, and the first answer sentence that waited on it, no longer spent.
    expect(dropped.reduce((sum, turn) => sum + turn.searchMs!, 0)).toBe(1_963);
  });

  it('keeps the tool for a follow-up statement after a short search answer, which asks no question', () => {
    // SEARCH_INSTRUCTIONS ask for one or two sentences that start with the key fact, so the answer
    // before a follow-up often ends without a question mark.
    const history = [
      { role: 'assistant' as const, content: 'Zagreb in December averages about 3 degrees.' },
    ];
    for (const input of [
      'And in Split.',
      'Same for Rome.',
      'Euro exchange rate today.',
      'Museums open on Monday in Florence.',
      'I would like recommendations for Lisbon.',
      'Best time to visit Santorini.',
      'Restaurants near the Colosseum.',
    ])
      expect(unclearForSearch({ input, history }), input).toBeUndefined();
  });

  it('takes "I can’t confirm" for no offer, so a yes to it does not search', () => {
    const after = (content: string) => [{ role: 'assistant' as const, content }];
    expect(
      unclearForSearch({
        input: 'Yeah.',
        history: after('I can’t confirm live availability for those exact dates.'),
      }),
    ).toBe('backchannel');
    expect(unclearForSearch({ input: 'Yeah.', history: after('I couldn’t find that one.') })).toBe(
      'backchannel',
    );
    expect(
      unclearForSearch({ input: 'Oh, my God.', history: after('Shall I check the fares?') }),
    ).toBe('backchannel');
    expect(
      unclearForSearch({ input: 'Thank you.', history: after('Shall I check the fares?') }),
    ).toBe('backchannel');
  });
});
