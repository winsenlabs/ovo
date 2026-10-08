import { describe, expect, it } from 'vitest';
import { AgentReplyPacing } from '@winsendotai/ovo-contracts';
import { streamAgentReply } from '../src/agent-stream.ts';
import { StreamingTextSegmenter } from '../src/text-segmenter.ts';

type Options = ConstructorParameters<typeof StreamingTextSegmenter>[2];

/** Streams `reply` one word per delta, as a model does, and returns every segment in order. */
function streamed(reply: string, options: Options = {}): string[] {
  const segmenter = new StreamingTextSegmenter(undefined, undefined, options);
  const words = reply.split(' ');
  const out = words.flatMap((word, index) =>
    segmenter.push(index === words.length - 1 ? word : `${word} `),
  );
  return [...out, ...segmenter.finish()];
}

describe('Wave 8 Fix 5: the first segment ends at the first natural phrase', () => {
  it('cuts a long first sentence with no comma before a phrase opener, then speaks whole sentences', () => {
    expect(
      streamed(
        'I found three good options for your trip to Paris next week in October. The first is a river cruise.',
      ),
    ).toEqual([
      'I found three good options for your trip',
      'to Paris next week in October.',
      'The first is a river cruise.',
    ]);
  });

  it('cuts at the word cap when no opener comes, on a word that ends a phrase', () => {
    const reply = 'Yes the new rail pass seems really good value overall this year.';
    expect(streamed(reply)).toEqual([
      'Yes the new rail pass seems really good value overall',
      'this year.',
    ]);
    expect(streamed(reply, { firstPhraseWords: 6 })).toEqual([
      'Yes the new rail pass seems',
      'really good value overall this year.',
    ]);
    // Long words reach the 60-character first-segment cap first: cut at its last safe break.
    expect(
      streamed('Honestly the museum pass seems really worth buying here considering everything.'),
    ).toEqual([
      'Honestly the museum pass seems really worth buying here',
      'considering everything.',
    ]);
  });

  it('still prefers a clause mark or a sentence end that comes first', () => {
    expect(streamed('Sure Rahul ji, your EMI is due on the fifth of this month for sure.')).toEqual(
      ['Sure Rahul ji,', 'your EMI is due on the fifth of this month for sure.'],
    );
    expect(streamed('Yes. Paris is lovely in October and the crowds are smaller.')).toEqual([
      'Yes.',
      'Paris is lovely in October and the crowds are smaller.',
    ]);
  });

  it('never cuts inside an amount, a date or a phone number', () => {
    const said = streamed(
      'Your loan ending 4 2 1 3 has an overdue amount of two thousand five hundred rupees due on 5 October.',
    );
    expect(said).toEqual([
      'Your loan ending 4 2 1 3 has an overdue',
      'amount of two thousand five hundred rupees due on 5 October.',
    ]);
    expect(
      streamed('The total you owe us right now is 4,500 rupees and 590 rupees in charges.'),
    ).toEqual(['The total you owe us right now is 4,500 rupees', 'and 590 rupees in charges.']);
  });

  it('never cuts inside a name', () => {
    const said = streamed(
      'I spoke with Mr Rahul Kumar Sharma from New Delhi yesterday about the payment plan.',
    );
    expect(said[0]).toBe('I spoke with Mr Rahul Kumar Sharma');
    expect(said[1]).toBe('from New Delhi yesterday about the payment plan.');
  });

  it('never cuts inside a quote, at a word or at a comma', () => {
    expect(
      streamed('He told me “please call me again tomorrow after lunch and before dinner” today.'),
    ).toEqual(['He told me “please call me again tomorrow after lunch and before dinner” today.']);
    // A comma inside a quote is no clause end: the old rule cut "He said “Wait," here.
    expect(streamed('He said “Wait, I am coming” and then he left.')).toEqual([
      'He said “Wait, I am coming”',
      'and then he left.',
    ]);
  });

  it('cuts an over-long first segment at its last safe break, never mid-number', () => {
    // Before: the 60-character cap cut at the last space, between two digit groups.
    expect(
      streamed('Numbers 1234 5678 9012 3456 7890 1234 5678 9012 3456 7890 4321 are all linked.'),
    ).toEqual(['Numbers 1234 5678 9012 3456 7890 1234 5678 9012 3456 7890 4321 are all linked.']);
  });

  it('keeps the old pacing with firstPhraseWords 0, and rejects a negative one', () => {
    expect(
      streamed('I found three good options for your trip to Paris next week in October.', {
        firstPhraseWords: 0,
      }),
    ).toEqual(['I found three good options for your trip to Paris next week', 'in October.']);
    expect(
      () => new StreamingTextSegmenter(undefined, undefined, { firstPhraseWords: -1 }),
    ).toThrow('firstPhraseWords');
  });

  it("takes the agent's reply pacing: firstPhraseWords from config, or minFirstWords alone", async () => {
    const reply = 'Yes the new rail pass seems really good value overall this year.';
    const segments = async (pace?: AgentReplyPacing | number) => {
      const events = (async function* () {
        for (const word of reply.split(' '))
          yield { kind: 'text-delta' as const, delta: `${word} ` };
      })();
      const out: string[] = [];
      for await (const segment of streamAgentReply(
        events,
        'en-IN',
        () => undefined,
        (text) => text,
        undefined,
        undefined,
        pace,
      ))
        out.push(segment);
      return out;
    };
    expect(await segments(AgentReplyPacing.parse({ firstPhraseWords: 6 }))).toEqual([
      'Yes the new rail pass seems',
      'really good value overall this year.',
    ]);
    expect(await segments(3)).toEqual([
      'Yes the new rail pass seems really good value overall',
      'this year.',
    ]);
    expect(() => AgentReplyPacing.parse({ firstPhraseWords: 41 })).toThrow();
  });
});

/**
 * Replay against call f3363705 turn 3 (latency-evidence.md): the model's first token came 1367 ms
 * after the turn was taken and TTS first byte took ~146 ms. The model then streams one word per
 * `WORD_MS`: an assumption (~50 tokens/s), not a measurement; the call log has no per-token times.
 */
const FIRST_TOKEN_MS = 1367;
const WORD_MS = 25;
const TTS_FIRST_BYTE_MS = 146;

function firstAudioMs(reply: string, options: Options): { ms: number; first: string } {
  const segmenter = new StreamingTextSegmenter(undefined, undefined, options);
  const words = reply.split(' ');
  for (const [index, word] of words.entries()) {
    const last = index === words.length - 1;
    const ready = [
      ...segmenter.push(last ? word : `${word} `),
      ...(last ? segmenter.finish() : []),
    ];
    if (ready.length)
      return { ms: FIRST_TOKEN_MS + index * WORD_MS + TTS_FIRST_BYTE_MS, first: ready[0]! };
  }
  throw new Error('no segment');
}

describe('Fix 5 on the turn-3 timeline', () => {
  it('starts a long trip answer 4 words sooner than the 60-character cap did', () => {
    const reply =
      'I found three good options for your trip to Paris next week in October, all under budget.';
    const before = firstAudioMs(reply, { firstPhraseWords: 0 });
    const after = firstAudioMs(reply, {});
    expect(before).toEqual({
      ms: FIRST_TOKEN_MS + 12 * WORD_MS + TTS_FIRST_BYTE_MS,
      first: 'I found three good options for your trip to Paris next week',
    });
    expect(after).toEqual({
      ms: FIRST_TOKEN_MS + 8 * WORD_MS + TTS_FIRST_BYTE_MS,
      first: 'I found three good options for your trip',
    });
    expect(before.ms - after.ms).toBe(100);
  });

  it('saves the rest of the sentence on a long first sentence with no early comma', () => {
    const reply =
      'The Louvre is open until nine on Fridays so you could go in the evening when it is quieter.';
    const sentence = firstAudioMs(reply, { firstPhraseWords: 0, firstSegmentMaxChars: 240 });
    const phrase = firstAudioMs(reply, {});
    expect(phrase.first).toBe('The Louvre is open until nine on Fridays');
    // A whole first sentence waits for its 19th word; the first phrase goes when "so", the 9th,
    // has streamed in ("nine | on" is never cut: a number).
    expect(sentence.ms - phrase.ms).toBe(10 * WORD_MS);
  });
});

/**
 * Replay of the replies Maya streamed on call 6e1a4e3a (2026-10-08, /tmp/ovo/last-call-turns.json;
 * fillers and search lines left out), one word per delta. Turn 7 measured the model's pace: its
 * first segment (9 words) was ready 274 ms after its first token, about 30 ms a word.
 */
const MEASURED_WORD_MS = 30;
const CALL3: [turn: string, reply: string, before: string, after: string][] = [
  [
    'turn-10',
    'I’m not sure what you mean by “Hardik.” Did you mean a person named Hardik, or something else?',
    'I’m not sure what you mean by “Hardik.”',
    'I’m not sure what you mean',
  ],
  [
    'turn-20',
    'Got it: December 20, 2026, to January 1, 2027, for two passengers. I can’t confirm live availability.',
    'Got it: December 20, 2026,',
    'Got it: December 20, 2026,',
  ],
  [
    'turn-7',
    'The Nazis were members of a German far-right political movement led by Adolf Hitler.',
    'The Nazis were members of a German far-right political',
    'The Nazis were members of a German far-right political',
  ],
  [
    'turn-18',
    'Just to confirm, you mean December 20, 2026, returning January 1, 2027, right?',
    'Just to confirm,',
    'Just to confirm,',
  ],
];

describe('Fix 5 replayed on call 6e1a4e3a', () => {
  it.each(CALL3)('%s: first segment, and when it is ready', (_turn, reply, before, after) => {
    const old = firstAudioMs(reply, { firstPhraseWords: 0 });
    const now = firstAudioMs(reply, {});
    expect(old.first).toBe(before);
    expect(now.first).toBe(after);
  });

  it('turn 10 speaks two words sooner: ~60 ms at the measured pace', () => {
    const words = (text: string) => text.split(' ').length;
    const [, , before, after] = CALL3[0]!;
    expect((words(before) - words(after)) * MEASURED_WORD_MS).toBe(60);
  });

  it('turn 20 no longer splits its date at the comma, also when the year streams in later', () => {
    // Live, "Got it: December 20," was spoken alone and "2026, to January 1, ..." after it.
    const segmenter = new StreamingTextSegmenter();
    expect(segmenter.push('Got it: December 20, ')).toEqual([]);
    expect(segmenter.push('2026, to January 1, 2027, for two. ')).toEqual([
      'Got it: December 20, 2026,',
    ]);
    expect(segmenter.finish()).toEqual(['to January 1, 2027, for two.']);
    // A comma after a number that no number follows still ends the clause.
    expect(streamed('I can do 500, and the rest by Friday, if that works for you.')[0]).toBe(
      'I can do 500,',
    );
  });
});
