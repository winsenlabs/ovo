import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { DEFAULT_MORE_LINES } from '../src/reply-cap.ts';
import { call, collect, execution, llm, receipt, variables } from './agent-call-control-fixture.ts';

/**
 * Wave 9, Maya call 10d5ef30 issue D5 (2026-10-12): five answers ended "Want more detail?" (turns
 * 9, 10, 14, 17 and 18), twice on consecutive turns, and turn 17's was most of what it said. The
 * call's turns as they played, each with the model's answer as the caller heard it (the filler
 * line aside, which the engine says). The capped answers' held sentences were never logged: each
 * ends with one marked MODELLED, long enough to trip the cap as it did live.
 */
const ANSWERS = [
  {
    caller: 'Uh, what do you think about Zagreb as a place?',
    model:
      'Zagreb could be a lovely fit: its Advent festival is scheduled for November 28, 2026, through January 7, 2027, so it’ll be running during your trip. ' +
      /* MODELLED */ 'Its Upper Town fills with lights, mulled wine stalls and music every evening.',
  },
  {
    caller: 'Yeah, yeah.',
    model:
      'Zagreb’s Advent is centered around the main squares and parks, with festive lights, food stalls, and seasonal events, so it’s a pleasant city to explore on foot. ' +
      /* MODELLED */ 'Ban Jelačić Square and Zrinjevac Park are the busiest spots.',
  },
  {
    caller:
      "No, umm... Umm, I'm just thinking of whether we should go this year or next. What about Northern Lights and stuff like that? Will I get to see anything about, like, that?",
    model:
      'You could see the Northern Lights in late December, but Zagreb, Vienna, and Prague are too far south for reliable viewing; you’d want to add somewhere like Tromsø in northern Norway, where aurora season runs through winter, though clear skies and sightings aren’t guaranteed. Would you be open to adding a few nights in the Arctic?',
  },
  {
    caller:
      "Yeah, I don't mind, but, uh, don't make it, like, too far away or impossible to reach. And stuff like that. I mean, it should still be a built-in.",
    model:
      'Do you mean you want a Northern Lights stop that fits naturally into the same trip and is reasonably easy to reach from your other cities?',
  },
  {
    caller: "Yeah, that's what I said, right?",
    model:
      'You’re right—you already said that. ' +
      // MODELLED: the answer the caller asked for next (turn 18's), which the cap held back here.
      'Tromsø is a realistic add-on from Vienna, with a seasonal nonstop flight expected to begin November 28, 2026; otherwise, you can connect through Oslo. ' +
      'Flights take about three hours.',
  },
  {
    caller: "Yeah, dude. That's why I'm asking.",
    model:
      'Sorry—I should’ve answered that directly: Tromsø is a realistic add-on from Vienna, with a seasonal nonstop flight expected to begin November 28, 2026; otherwise, you can connect through Oslo. ' +
      /* MODELLED */ 'Three or four nights there gives you the best odds of clear skies.',
  },
];

async function replay(answers = ANSWERS) {
  const model = llm(answers.map(({ model: text }) => ({ kind: 'text' as const, text })));
  const behavior = new AgentBehavior(
    AgentConfig.parse({ name: 'Maya', mode: 'agent', language: 'en', variables }),
    model.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', now: () => new Date('2026-10-12T15:57:17Z') },
  );
  const said: string[][] = [];
  for (const [index, { caller }] of answers.entries()) {
    behavior.beginTurn(index + 1);
    const lines = await collect(behavior.respondStream(caller, call));
    for (const line of lines) behavior.onPlayback(receipt(line, index + 1));
    said.push(lines);
  }
  return said;
}

const offers = new Set(DEFAULT_MORE_LINES);

describe('call 10d5ef30 D5: the long-answer offer only now and then', () => {
  it('never offers on consecutive turns, never after a short answer, and varies the wording', async () => {
    const said = await replay();
    // Live: turns 9, 10, 17 and 18 ended "Want more detail?" (14's never played: superseded).
    // Wave 12 (call 8cb76efc F7): a short tail the cap held is said instead of offered (turns 9,
    // 10 and 17); turn 18's is longer and offered. Before: offers on turns 9 and 17.
    expect(
      said.map((lines) => lines.at(-1)).map((last) => (offers.has(last!) ? last : '…')),
    ).toEqual(['…', '…', '…', '…', '…', 'Want more detail?']);
    expect(said[1]!.join(' ')).toBe(
      'Zagreb’s Advent is centered around the main squares and parks, with festive lights, food stalls, and seasonal events, so it’s a pleasant city to explore on foot. Ban Jelačić Square and Zrinjevac Park are the busiest spots.',
    );
    // Turn 17: its 35-character first sentence is a short answer, so the answer that follows it is
    // said, never an offer in its place. Wave 12 (F5): its semicolon ends a sentence.
    expect(said[4]!.join(' ')).toBe(
      'You’re right—you already said that. Tromsø is a realistic add-on from Vienna, with a seasonal nonstop flight expected to begin November 28, 2026. Otherwise, you can connect through Oslo. Flights take about three hours.',
    );
    expect(said[5]!.join(' ')).toMatch(/expected to begin November 28, 2026\. Want more detail\?$/);
  });

  it('offers again only once three turns have passed without one, in the next wording', async () => {
    // Turn 9's answer with more held back than a short tail.
    const zagreb = {
      ...ANSWERS[0]!,
      model: `${ANSWERS[0]!.model} The Christmas market on Zrinjevac runs every day until the 7th of January.`,
    };
    const said = await replay([zagreb, ANSWERS[3]!, zagreb, ANSWERS[3]!, zagreb]);
    // Wave 12 (call 8cb76efc F7): "every other turn" offered on turns 13, 19, 25, 28 and 30. Before:
    // offers on the 1st, 3rd and 5th answers.
    expect(said.map((lines) => lines.at(-1))).toEqual([
      'Want more detail?',
      expect.stringMatching(/other cities\?$/),
      expect.stringMatching(/during your trip\.$/),
      expect.stringMatching(/other cities\?$/),
      'Want to hear more?',
    ]);
  });
});
