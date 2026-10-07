import { MULAW_8K, type NetFixtureScript, type SttEvent } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsStt } from '../src/provider.ts';
import { STALE_PARTIAL_MS, ScribeSegments } from '../src/segments.ts';
import { RETRIEVED, SOURCE, committed, partial, sessionStarted } from '../src/testing.ts';

const transcripts = (events: SttEvent[]) =>
  events.flatMap((event) =>
    event.type === 'transcript'
      ? [`${event.segment.segmentId}:${event.segment.stability}:${event.segment.text}`]
      : event.type === 'end-of-turn'
        ? ['end-of-turn']
        : [],
  );

function segments() {
  let now = 0;
  const events: SttEvent[] = [];
  const scribe = new ScribeSegments(
    (event) => events.push(event),
    () => now,
  );
  return { scribe, events, advance: (ms: number) => (now += ms) };
}

describe('N5: a partial that lands after its commit opens no phantom segment', () => {
  it('drops a late partial equal to the commit (call 50ac3860, turn 17 "I am drunk.")', () => {
    const { scribe, events, advance } = segments();
    scribe.onPartial('I am');
    scribe.onCommitted('I am drunk.');
    // 13:47:48.388 final, 13:47:48.411 the same words again as an interim: 23 ms.
    advance(23);
    scribe.onPartial('I am drunk.');
    expect(transcripts(events)).toEqual(['0:interim:I am', '0:final:I am drunk.', 'end-of-turn']);
  });

  it('drops a late prefix of the commit, then opens the next segment on new words (turn 20)', () => {
    const { scribe, events, advance } = segments();
    scribe.onCommitted('Okay. याद नहीं।');
    // 13:48:00.001 final, 13:48:00.013 'Okay. य', then the caller's next words.
    advance(12);
    scribe.onPartial('Okay. य');
    advance(1_000);
    scribe.onPartial('I...');
    scribe.onPartial('I think so.');
    expect(transcripts(events)).toEqual([
      '0:final:Okay. याद नहीं।',
      'end-of-turn',
      '1:interim:I...',
      '1:interim:I think so.',
    ]);
  });

  it('drops a punctuation-only partial right after a commit', () => {
    const { scribe, events } = segments();
    scribe.onCommitted('Hello');
    scribe.onPartial('?');
    expect(transcripts(events)).toEqual(['0:final:Hello', 'end-of-turn']);
  });

  it('ignores case and punctuation when comparing with the commit', () => {
    const { scribe, events } = segments();
    scribe.onCommitted('Yes, this is him.');
    scribe.onPartial('yes this is');
    expect(transcripts(events)).toEqual(['0:final:Yes, this is him.', 'end-of-turn']);
  });

  it('hears the same words again once new words came between them', () => {
    const { scribe, events } = segments();
    scribe.onCommitted('haan');
    scribe.onPartial('nahi');
    scribe.onCommitted('nahi');
    scribe.onPartial('haan');
    expect(transcripts(events).filter((line) => line.includes('interim'))).toEqual([
      '1:interim:nahi',
      '2:interim:haan',
    ]);
  });

  it(`hears a caller who repeats the committed words after ${STALE_PARTIAL_MS} ms`, () => {
    const { scribe, events, advance } = segments();
    scribe.onCommitted('Hello');
    advance(STALE_PARTIAL_MS + 1);
    scribe.onPartial('Hello');
    expect(transcripts(events)).toEqual(['0:final:Hello', 'end-of-turn', '1:interim:Hello']);
  });

  it('still finalises a commit whose words repeat the last one', () => {
    const { scribe, events } = segments();
    scribe.onCommitted('Hello');
    scribe.onPartial('Hello');
    scribe.onCommitted('Hello');
    expect(transcripts(events)).toEqual([
      '0:final:Hello',
      'end-of-turn',
      '1:final:Hello',
      'end-of-turn',
    ]);
  });
});

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

async function session(lateAfterMs: number) {
  const clock = new FakeClock();
  const script: NetFixtureScript[] = [
    {
      host: 'api.elevenlabs.io',
      source: SOURCE,
      retrieved: RETRIEVED,
      steps: [
        { expect: 'ws-open', url: /^wss:\/\/api\.elevenlabs\.io\// },
        { send: sessionStarted() },
        {
          expect: 'ws-send',
          match: 'json',
          where: { message_type: 'input_audio_chunk', commit: false },
          repeat: 'until-next',
        },
        { send: committed('I am drunk.') },
        ...(lateAfterMs ? [{ delayMs: lateAfterMs }] : []),
        { send: partial('I am drunk.') },
      ],
    },
  ];
  const net = createFixtureNet(script, { clock });
  const events: SttEvent[] = [];
  const started = await new ElevenLabsStt(net, 'fixture-key', {}, clock).start({
    sessionId: 'scribe-n5',
    format: MULAW_8K,
    language: 'en-IN',
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    onUsage: () => undefined,
  });
  await started.write(new Uint8Array(400).fill(1));
  await clock.advanceAsync(lateAfterMs);
  await started.cancel('done');
  return transcripts(events);
}

describe('N5 through a session', () => {
  it('drops the late partial the provider sends right after its commit', async () => {
    expect(await session(0)).toEqual(['0:final:I am drunk.', 'end-of-turn']);
  });

  it("measures the stale window on the session's clock", async () => {
    expect(await session(STALE_PARTIAL_MS + 500)).toEqual([
      '0:final:I am drunk.',
      'end-of-turn',
      '1:interim:I am drunk.',
    ]);
  });
});
