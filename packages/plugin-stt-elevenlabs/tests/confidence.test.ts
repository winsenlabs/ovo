import { MULAW_8K, type NetFixtureScript, type SttEvent } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIDENCE_MISSES, CONFIDENCE_SLOW_MS, CONFIDENCE_WAIT_MS } from '../src/confidence.ts';
import { wordConfidence } from '../src/protocol.ts';
import { ElevenLabsStt, type ElevenLabsSttBinding } from '../src/provider.ts';
import { RETRIEVED, SOURCE, committed, committedWords, sessionStarted } from '../src/testing.ts';

// Wave 8, call 6e1a4e3a in a noisy cafe: "Hardik?", "Hello, if madam..." and "Credit. Okay,
// so..." reached the agent as clear words. The word-level message after each commit carries the
// words' log probabilities; the final now carries their confidence for the turn detector.

const AUDIO = {
  expect: 'ws-send',
  match: 'json',
  where: { message_type: 'input_audio_chunk', commit: false },
  repeat: 'until-next',
} as const;
const COMMIT = {
  expect: 'ws-send',
  match: 'json',
  where: { message_type: 'input_audio_chunk', commit: true },
} as const;

async function open(
  steps: NetFixtureScript['steps'],
  binding: ElevenLabsSttBinding = {},
  agent: ConstructorParameters<typeof ElevenLabsStt>[4] = {},
) {
  const clock = new FakeClock();
  const net = createFixtureNet(
    [
      {
        host: 'api.elevenlabs.io',
        source: SOURCE,
        retrieved: RETRIEVED,
        steps: [{ expect: 'ws-open', url: /^wss:\/\/api\.elevenlabs\.io\// }, ...steps],
      },
    ],
    { clock },
  );
  const events: SttEvent[] = [];
  const session = await new ElevenLabsStt(net, 'fixture-key', binding, clock, agent).start({
    sessionId: 'scribe-confidence',
    format: MULAW_8K,
    language: 'en-IN',
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    onUsage: () => undefined,
  });
  return { clock, net, events, session };
}

const finals = (events: SttEvent[]) =>
  events.flatMap((event) =>
    event.type === 'transcript' && event.segment.stability === 'final'
      ? [{ text: event.segment.text, confidence: event.segment.confidence }]
      : [],
  );
const frame = () => new Uint8Array(400).fill(1);

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('word confidence from the word-level message', () => {
  it('is the geometric mean of the words, skipping spacing and words without one', () => {
    const words = [
      { text: 'Hardik?', type: 'word', logprob: Math.log(0.2) },
      { text: ' ', type: 'spacing', logprob: -9 },
      { text: 'yes', type: 'word', logprob: Math.log(0.8) },
      { text: 'no-score', type: 'word' },
    ];
    expect(wordConfidence(words)).toBeCloseTo(0.4, 6);
    expect(wordConfidence([{ text: 'ok', type: 'word', logprob: 0.3 }])).toBe(1);
    expect(wordConfidence([{ text: 'ok', type: 'word' }])).toBeUndefined();
    expect(wordConfidence(null)).toBeUndefined();
  });
});

describe('a final with its confidence', () => {
  it('holds the final until the word-level message, then carries its confidence', async () => {
    const { clock, events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('Hardik?') },
      { delayMs: 15 },
      { send: committedWords('Hardik?', [Math.log(0.12)]) },
    ]);
    await session.write(frame());
    await session.forceEndpoint!();
    // Committed, but its word-level message is 15 ms behind: the turn has not ended yet.
    expect(events.some((event) => event.type === 'end-of-turn')).toBe(false);
    await clock.advanceAsync(15);
    expect(finals(events)).toEqual([{ text: 'Hardik?', confidence: expect.closeTo(0.12, 6) }]);
    expect(events.at(-1)).toEqual({ type: 'end-of-turn' });
    await session.cancel('done');
  });

  it('logs how long Scribe took to answer each commit (Wave 10)', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const { clock, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { delayMs: 340 },
      { send: committed('Chennai, Chennai.') },
      { send: committedWords('Chennai, Chennai.') },
    ]);
    await session.write(frame());
    await session.forceEndpoint!();
    await clock.advanceAsync(340);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.find((entry) => entry.event === 'stt_commit_answered')).toMatchObject({
      sessionId: 'scribe-confidence',
      latencyMs: 340,
      empty: false,
    });
    await session.cancel('done');
  });

  it('a clear reply carries a high confidence', async () => {
    const { events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('No. Can you check for flights from Chennai to Frankfurt?') },
      { send: committedWords('No. Can you check for flights from Chennai to Frankfurt?') },
    ]);
    await session.write(frame());
    await session.forceEndpoint!();
    expect(finals(events)[0]!.confidence).toBeGreaterThan(0.9);
    await session.cancel('done');
  });

  it(`waits at most ${CONFIDENCE_WAIT_MS} ms, and stops waiting after ${CONFIDENCE_MISSES} misses`, async () => {
    const { clock, events, session } = await open([
      { send: sessionStarted() },
      ...Array.from({ length: 3 }, (_, i) => [
        AUDIO,
        COMMIT,
        { send: committed(`turn ${i}`) },
      ]).flat(),
      AUDIO,
    ]);
    for (let i = 0; i < CONFIDENCE_MISSES; i++) {
      await session.write(frame());
      await session.forceEndpoint!();
      await clock.advanceAsync(CONFIDENCE_WAIT_MS - 1);
      expect(finals(events)).toHaveLength(i);
      await clock.advanceAsync(1);
      expect(finals(events)).toEqual(
        Array.from({ length: i + 1 }, (_, k) => ({ text: `turn ${k}`, confidence: undefined })),
      );
    }
    // The provider sends no word-level messages: later finals are not held at all.
    await session.write(frame());
    await session.forceEndpoint!();
    expect(finals(events)).toHaveLength(CONFIDENCE_MISSES + 1);
    await session.cancel('done');
  });

  it('is off when the binding turns it off: the final goes out on the commit', async () => {
    const { events, session } = await open(
      [{ send: sessionStarted() }, AUDIO, COMMIT, { send: committed('theek hai') }],
      { confidence: false },
    );
    await session.write(frame());
    await session.forceEndpoint!();
    expect(finals(events)).toEqual([{ text: 'theek hai', confidence: undefined }]);
    await session.cancel('done');
  });

  it('finish waits for the held final, then closes normally', async () => {
    const { clock, net, events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('theek hai') },
    ]);
    await session.write(frame());
    let finished = false;
    const finishing = session.finish().then(() => (finished = true));
    await clock.advanceAsync(CONFIDENCE_WAIT_MS - 1);
    expect(finished).toBe(false);
    await clock.advanceAsync(1);
    await finishing;
    expect(finals(events)).toEqual([{ text: 'theek hai', confidence: undefined }]);
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close', data: '1000 ' });
  });

  it('a refused commit releases the final still held before it', async () => {
    const { events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('main payment') },
      { send: JSON.stringify({ message_type: 'commit_throttled', error: 'too soon' }) },
    ]);
    await session.write(frame());
    await session.forceEndpoint!();
    expect(finals(events)).toEqual([{ text: 'main payment', confidence: undefined }]);
    await session.cancel('done');
  });
});

describe('the cost of waiting for confidence (latency)', () => {
  /** One turn: a commit answered by its word-level message `afterMs` later. */
  const turn = (text: string, afterMs: number) => [
    AUDIO,
    COMMIT,
    { send: committed(text) },
    ...(afterMs ? [{ delayMs: afterMs }] : []),
    { send: committedWords(text) },
  ];
  const ended = (events: SttEvent[]) => events.filter((event) => event.type === 'end-of-turn');

  it(`keeps waiting while the messages are prompt (at most ${CONFIDENCE_SLOW_MS} ms a turn)`, async () => {
    const { clock, events, session } = await open([
      { send: sessionStarted() },
      ...Array.from({ length: 5 }, (_, i) => turn(`turn ${i}`, CONFIDENCE_SLOW_MS)).flat(),
      AUDIO,
    ]);
    for (let i = 0; i < 5; i++) {
      await session.write(frame());
      await session.forceEndpoint!();
      await clock.advanceAsync(CONFIDENCE_SLOW_MS);
    }
    expect(finals(events).every((final) => final.confidence !== undefined)).toBe(true);
    expect(finals(events)).toHaveLength(5);
    await session.cancel('done');
  });

  it(`counts a slow message as a miss: after ${CONFIDENCE_MISSES} the finals stop waiting`, async () => {
    // Regression: a message inside the cap reset the count, so a steady 100 ms gap was paid on
    // every turn of the call.
    const slow = CONFIDENCE_SLOW_MS + 5;
    const { clock, events, session } = await open([
      { send: sessionStarted() },
      ...Array.from({ length: CONFIDENCE_MISSES }, (_, i) => turn(`slow ${i}`, slow)).flat(),
      AUDIO,
      COMMIT,
      { send: committed('no wait') },
      AUDIO,
    ]);
    for (let i = 0; i < CONFIDENCE_MISSES; i++) {
      await session.write(frame());
      await session.forceEndpoint!();
      await clock.advanceAsync(slow);
    }
    await session.write(frame());
    await session.forceEndpoint!();
    // Ended on the commit itself, with no wait.
    expect(finals(events).at(-1)).toEqual({ text: 'no wait', confidence: undefined });
    expect(ended(events)).toHaveLength(CONFIDENCE_MISSES + 1);
    await session.cancel('done');
  });

  it('never holds an empty commit: noise that transcribed to nothing ends at once', async () => {
    const { events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('') },
    ]);
    await session.write(frame());
    await session.forceEndpoint!();
    expect(events).toEqual([{ type: 'end-of-turn' }]);
    await session.cancel('done');
  });

  it('ignores a late message for an earlier commit instead of taking its confidence', async () => {
    const { clock, events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('first') },
      { delayMs: CONFIDENCE_WAIT_MS },
      AUDIO,
      COMMIT,
      { send: committed('second') },
      { send: committedWords('first', [Math.log(0.1)]) },
      { send: committedWords('second', [Math.log(0.9)]) },
    ]);
    await session.write(frame());
    await session.forceEndpoint!();
    await clock.advanceAsync(CONFIDENCE_WAIT_MS);
    await session.write(frame());
    await session.forceEndpoint!();
    expect(finals(events)).toEqual([
      { text: 'first', confidence: undefined },
      { text: 'second', confidence: expect.closeTo(0.9, 6) },
    ]);
    await session.cancel('done');
  });
});

describe('a held final when the session ends', () => {
  it('is delivered when the provider drops the session inside the wait', async () => {
    // Regression: the drop disposed of the held commit, and the caller's last words were lost.
    const { clock, events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('I will pay on Friday.') },
      { delayMs: 5 },
      { close: { code: 1011, reason: 'internal' } },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await session.write(frame());
    await session.forceEndpoint!();
    await clock.advanceAsync(5);
    expect(finals(events)).toEqual([{ text: 'I will pay on Friday.', confidence: undefined }]);
    expect(events.at(-1)).toEqual({ type: 'end-of-turn' });
    await expect(session.write(frame())).rejects.toMatchObject({ code: 1011, retryable: true });
  });

  it('is delivered when the session is cancelled inside the wait', async () => {
    const { events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('theek hai') },
    ]);
    await session.write(frame());
    await session.forceEndpoint!();
    await session.cancel('done');
    expect(finals(events)).toEqual([{ text: 'theek hai', confidence: undefined }]);
  });
});

describe("the agent's name", () => {
  it('is favoured as a keyterm and restored where the caller addresses the agent', async () => {
    const { net, events, session } = await open(
      [
        { send: sessionStarted() },
        AUDIO,
        COMMIT,
        { send: committed('Okay. Thank you, Danny.') },
        { send: committedWords('Okay. Thank you, Danny.') },
      ],
      {},
      { agentName: 'Maya', agentNameMishearings: ['Danny'], keyterms: ['Zagreb'] },
    );
    const url = new URL((net.log.find((entry) => entry.kind === 'ws-open') as { url: string }).url);
    expect(url.searchParams.getAll('keyterms')).toEqual(['Maya', 'Zagreb']);
    await session.write(frame());
    await session.forceEndpoint!();
    // Call 6e1a4e3a, the last turn.
    expect(finals(events).map((final) => final.text)).toEqual(['Okay. Thank you, Maya.']);
    await session.cancel('done');
  });
});
