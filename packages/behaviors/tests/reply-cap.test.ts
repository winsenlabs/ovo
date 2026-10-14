import { describe, expect, it } from 'vitest';
import { AgentReplyPacing, type InferenceStreamEvent } from '@winsendotai/ovo-contracts';
import { streamAgentReply } from '../src/agent-stream.ts';
import { interceptLateResume } from '../src/flow-rejoin.ts';

/**
 * Streams `reply` one word per delta, then `after` and the provider's `finish`, through the voice
 * path; returns what is said and whether the stream was read to its `finish`.
 */
async function say(
  reply: string,
  pacing?: AgentReplyPacing,
  replyLanguage: string | null = 'en-IN',
  options: {
    after?: InferenceStreamEvent[];
    endAfterText?: (input: unknown, last?: string) => boolean | 'refused';
    guard?: (segment: string) => string | undefined;
    wrap?: (events: AsyncIterable<InferenceStreamEvent>) => AsyncIterable<InferenceStreamEvent>;
  } = {},
) {
  let finished = false;
  const events = (async function* (): AsyncGenerator<InferenceStreamEvent> {
    // As a provider streams it: no space after the last word, so the last sentence is only known
    // to be one when the stream ends.
    for (const [index, word] of reply.split(' ').entries())
      yield { kind: 'text-delta', delta: index ? ` ${word}` : word };
    yield* options.after ?? [];
    yield { kind: 'finish' };
    finished = true;
  })();
  const said: string[] = [];
  const stream = streamAgentReply(
    options.wrap ? options.wrap(events) : events,
    'en-IN',
    () => undefined,
    (text) => text,
    options.endAfterText,
    options.guard,
    pacing,
    replyLanguage ?? undefined,
  );
  for await (const line of stream) said.push(line);
  return { said: said.join(' '), lines: said, finished };
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
  it('turn 4: the Zagreb answer stops after its first sentence and asks its own question', async () => {
    const { said, finished } = await say(ZAGREB);
    // Wave 12 (call 8cb76efc F7): the short question the held rest ends on is said in place of
    // the offer. Before: "…and green spaces. Want more detail?"
    expect(said).toBe(
      'Zagreb is Croatia’s lively inland capital, with a lovely mix of historic streets, cafés, museums, and green spaces. Are you planning a short stop or a few days there?',
    );
    // ~21 s of speech became ~11 s. The rest is still read, not said: its `finish` meters the call.
    const seconds = (text: string) => Math.round(text.length / CHARS_PER_SECOND);
    expect([seconds(ZAGREB), seconds(said)]).toEqual([21, 11]);
    expect(finished).toBe(true);
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
    expect((await say(HAMBURG, { moreLine: 'Shall I go on?' })).said).toMatch(
      /explore\. Shall I go on\?$/,
    );
    expect((await say(ZAGREB, undefined, 'hi-IN')).said).toBe(ZAGREB);
    expect((await say(HAMBURG, { moreLine: 'और बताऊँ?' }, 'hi-IN')).said).toMatch(/और बताऊँ\?$/);
    expect(AgentReplyPacing.safeParse({ maxChars: 20 }).success).toBe(false);
    // A caller that does not name the reply language (the locale is not it) gets no cap at all.
    expect((await say(ZAGREB, undefined, null)).said).toBe(ZAGREB);
  });

  it('says a short tail it held instead of offering it (call 8cb76efc F7)', async () => {
    // Call 10d5ef30 turn 18: the clause after the semicolon, 40 characters, is not worth "Want to
    // hear more?"; it is said, and the answer ends where the model ended it.
    const tromso =
      'Sorry—I should’ve answered that directly: Tromsø is a realistic add-on from Vienna, with a seasonal nonstop flight expected to begin November 28, 2026; otherwise, you can connect through Oslo.';
    expect((await say(tromso)).lines).toEqual([
      'Sorry—I should’ve answered that directly:',
      'Tromsø is a realistic add-on from Vienna, with a seasonal nonstop flight expected to begin November 28, 2026.',
      'Otherwise, you can connect through Oslo.',
    ]);
  });

  it('runs the offer through the reply guard like any other line', async () => {
    const guard = (segment: string) => (segment === 'Want more detail?' ? undefined : segment);
    expect((await say(HAMBURG, undefined, 'en-IN', { guard })).lines).toEqual([
      'Of course.',
      'Zagreb has a historic Upper Town and a lively Lower Town, with cafés, museums, and leafy squares to explore.',
    ]);
  });
});

/** A collections goodbye longer than the cap, as the LLM ends a call with it (Wave 6 N1). */
const GOODBYE =
  'Thank you for your time today, Rahul. Your payment of four thousand rupees is confirmed for the fifth. Have a lovely evening!';

describe('call-3 #7: the cap never loses what follows the text', () => {
  it('says a goodbye whole and still ends the call on its end_call', async () => {
    // The last sentence is only segmented after `end_call` arrives; a longer goodbye is capped
    // mid-stream first, and what was held is said before the call ends.
    for (const goodbye of [GOODBYE, `${GOODBYE} We will send the receipt by SMS.`]) {
      const ended: unknown[] = [];
      const { said, finished } = await say(goodbye, undefined, 'en-IN', {
        after: [{ kind: 'tool', toolId: 'end_call', input: { reason: 'paid' } }],
        endAfterText: (input) => (ended.push(input), true),
      });
      expect(said).toBe(goodbye);
      expect(ended).toEqual([{ reason: 'paid' }]);
      expect(finished).toBe(true);
    }
  });

  it('keeps a capped answer capped when its end_call is refused (call 8cb76efc turn 16)', async () => {
    // Live, the model's end_call after a capped answer released every held sentence, though the
    // call refused it (the answer ended on a question): 20 s of speech and a citation marker.
    const lasts: (string | undefined)[] = [];
    const { said } = await say(ZAGREB, undefined, 'en-IN', {
      after: [{ kind: 'tool', toolId: 'end_call', input: { reason: 'answered' } }],
      endAfterText: (_input, last) => (lasts.push(last), 'refused'),
    });
    expect(said).toBe(
      'Zagreb is Croatia’s lively inland capital, with a lovely mix of historic streets, cafés, museums, and green spaces. Are you planning a short stop or a few days there?',
    );
    // The refusal is judged on the reply's real last line, which the cap held back.
    expect(lasts).toEqual(['Are you planning a short stop or a few days there?']);
  });

  it('rejoins the flow on a late resume_flow after a capped answer', async () => {
    const resumed: unknown[] = [];
    const answer =
      'We are open from nine to six on weekdays. On Saturdays we close at one. We are closed on Sundays. Public holidays follow the bank calendar, and we open late the day after.';
    const { said } = await say(answer, undefined, 'en-IN', {
      after: [{ kind: 'tool', toolId: 'resume_flow', input: { resume_at: 'payment' } }],
      wrap: (events) => interceptLateResume(events, (input) => resumed.push(input)),
    });
    expect(said).toBe(
      'We are open from nine to six on weekdays. On Saturdays we close at one. Want more detail?',
    );
    expect(resumed).toEqual([{ resume_at: 'payment' }]);
  });
});
