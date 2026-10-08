import { describe, expect, it } from 'vitest';
import { AgentReplyPacing } from '@winsendotai/ovo-contracts';
import { streamAgentReply } from '../src/agent-stream.ts';

/** Streams `reply` one word per delta through the voice path; returns what is said and read. */
async function say(reply: string, pacing?: AgentReplyPacing, language = 'en-IN') {
  let read = 0;
  const events = (async function* () {
    for (const word of reply.split(' ')) {
      read += 1;
      yield { kind: 'text-delta' as const, delta: `${word} ` };
    }
  })();
  const said: string[] = [];
  const stream = streamAgentReply(
    events,
    language,
    () => undefined,
    (text) => text,
    undefined,
    undefined,
    pacing,
  );
  for await (const line of stream) said.push(line);
  return { said: said.join(' '), read, words: reply.split(' ').length };
}

/**
 * Call 6e1a4e3a (2026-10-08, /tmp/ovo/last-call-turns.json): long search answers the caller talked
 * over (turns 4, 5) or sat through. Speaking time assumes ElevenLabs flash at ~15 characters a
 * second, an estimate: the call log has no per-line durations.
 */
const CHARS_PER_SECOND = 15;
const ZAGREB =
  'Zagreb is Croatia’s lively inland capital, with a lovely mix of historic streets, cafés, museums, and green spaces. I’d start around Ban Jelačić Square, browse Dolac Market, then wander the Upper Town to see St. Mark’s Church and enjoy the old-town atmosphere. Are you planning a short stop or a few days there?';
const HAMBURG =
  'Of course. Zagreb has a historic Upper Town and a lively Lower Town, with cafés, museums, and leafy squares to explore. Hamburg has a very different feel: it’s a maritime city known for its harbor, historic Speicherstadt warehouses, and striking Elbphilharmonie concert hall.';
const CHRISTMAS =
  'Christmas 2026, then— Lufthansa lists Chennai–Frankfurt service about five times a week, but I’ll need your exact departure and return dates to check available flights and fares. What day would you like to leave? Christmas 2026, then. Lufthansa lists Chennai–Frankfurt flights about five times a week, but I’ll need your travel dates to check specific flights and fares. What day would you like to leave?';

describe('call-3 #7: a long voice answer says two short sentences and offers more', () => {
  it('turn 4: the Zagreb answer stops after its first sentence and offers the rest', async () => {
    const { said, read, words } = await say(ZAGREB);
    expect(said).toBe(
      'Zagreb is Croatia’s lively inland capital, with a lovely mix of historic streets, cafés, museums, and green spaces. Want more detail?',
    );
    // ~21 s of speech became ~9 s; the model's stream was closed early, not read to its end.
    const seconds = (text: string) => Math.round(text.length / CHARS_PER_SECOND);
    expect([seconds(ZAGREB), seconds(said)]).toEqual([21, 9]);
    expect(read).toBeLessThan(words);
  });

  it('turn 5: a short first sentence leaves room for a second, then offers more', async () => {
    expect((await say(HAMBURG)).said).toBe(
      'Of course. Zagreb has a historic Upper Town and a lively Lower Town, with cafés, museums, and leafy squares to explore. Want more detail?',
    );
  });

  it('turn 16: ends on its own short question, and the repeated answer is never said', async () => {
    expect((await say(CHRISTMAS)).said).toBe(
      'Christmas 2026, then— Lufthansa lists Chennai–Frankfurt service about five times a week, but I’ll need your exact departure and return dates to check available flights and fares. What day would you like to leave?',
    );
  });

  it('says no offer after a question, and leaves a short answer alone', async () => {
    const confirm =
      'Just to confirm, you mean December 20, 2026, returning January 1, 2027, right? I can confirm Lufthansa operates nonstop service on this route, but I can’t verify live seat availability.';
    expect((await say(confirm)).said).toBe(
      'Just to confirm, you mean December 20, 2026, returning January 1, 2027, right?',
    );
    const short = 'Hi! What can I help you with for your Europe trip?';
    expect((await say(short)).said).toBe(short);
  });

  it('is configured per agent, and off for another language unless it has its own offer', async () => {
    expect((await say(ZAGREB, { maxSentences: 0 })).said).toBe(ZAGREB);
    expect((await say(HAMBURG, { maxChars: 2000, maxSentences: 3 })).said).toBe(HAMBURG);
    expect((await say(ZAGREB, { moreLine: 'Shall I go on?' })).said).toMatch(
      /spaces\. Shall I go on\?$/,
    );
    expect((await say(ZAGREB, undefined, 'hi-IN')).said).toBe(ZAGREB);
    expect((await say(ZAGREB, { moreLine: 'और बताऊँ?' }, 'hi-IN')).said).toMatch(/और बताऊँ\?$/);
    expect(AgentReplyPacing.safeParse({ maxChars: 20 }).success).toBe(false);
  });
});
