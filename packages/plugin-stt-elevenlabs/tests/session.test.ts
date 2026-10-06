import {
  MULAW_8K,
  PCM16_16K,
  type NetFixtureScript,
  type SttEvent,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet, decodeBase64 } from '@winsendotai/ovo-plugin-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsStt } from '../src/provider.ts';
import { FINISH_TIMEOUT_MS } from '../src/session.ts';
import { RETRIEVED, SOURCE, committed, partial, sessionStarted } from '../src/testing.ts';

const OPEN = { expect: 'ws-open', url: /^wss:\/\/api\.elevenlabs\.io\// } as const;
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

function script(steps: NetFixtureScript['steps']): NetFixtureScript[] {
  return [
    { host: 'api.elevenlabs.io', source: SOURCE, retrieved: RETRIEVED, steps: [OPEN, ...steps] },
  ];
}

async function open(steps: NetFixtureScript['steps'], format = MULAW_8K) {
  const clock = new FakeClock();
  const net = createFixtureNet(script(steps), { clock });
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  const session = await new ElevenLabsStt(net, 'fixture-key', {}, clock).start({
    sessionId: 'scribe-session',
    format,
    language: 'hi-IN',
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    onUsage: (meter) => usage.push(meter),
  });
  return { clock, net, events, usage, session };
}

/** The decoded outbound chunks, in order. */
function chunks(net: ReturnType<typeof createFixtureNet>) {
  return net.log.flatMap((entry) => {
    if (entry.kind !== 'ws-out' || typeof entry.data !== 'string') return [];
    const frame = JSON.parse(entry.data) as {
      audio_base_64: string;
      commit: boolean;
      sample_rate: number;
    };
    return [{ ...frame, audio: decodeBase64(frame.audio_base_64) }];
  });
}

const frame = (byte: number, bytes = 160) => new Uint8Array(bytes).fill(byte);
const transcripts = (events: SttEvent[]) =>
  events.flatMap((event) =>
    event.type === 'transcript'
      ? [`${event.segment.segmentId}:${event.segment.stability}:${event.segment.text}`]
      : event.type === 'end-of-turn'
        ? ['end-of-turn']
        : [],
  );

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('Scribe manual commit', () => {
  it('commits buffered audio on forceEndpoint and finalises the segment', async () => {
    const { net, events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      { send: partial('mera naam') },
      { send: partial('mera naam') },
      { send: partial('mera naam Ravi') },
      COMMIT,
      { send: committed('mera naam Ravi hai') },
      AUDIO,
      { send: partial('kal') },
    ]);
    // Three 20 ms frames: one 50 ms chunk goes out, 10 ms stays buffered for the commit.
    for (const byte of [1, 2, 3]) await session.write(frame(byte));
    await session.forceEndpoint!();
    await session.write(frame(4, 400));
    const sent = chunks(net);
    expect(sent.map((chunk) => [chunk.commit, chunk.audio.byteLength, chunk.sample_rate])).toEqual([
      [false, 400, 8000],
      [true, 160, 8000],
      [false, 400, 8000],
    ]);
    // The commit carries the 80 buffered bytes padded with mu-law silence to 20 ms.
    expect(sent[1]!.audio.slice(0, 80)).toEqual(frame(3, 80));
    expect(sent[1]!.audio.slice(80)).toEqual(new Uint8Array(80).fill(0xff));
    // A repeated partial is dropped; the commit locks segment 0 and the next partial opens 1.
    expect(transcripts(events)).toEqual([
      '0:interim:mera naam',
      '0:interim:mera naam Ravi',
      '0:final:mera naam Ravi hai',
      'end-of-turn',
      '1:interim:kal',
    ]);
    await session.cancel('done');
  });

  it('sends no commit when no audio arrived since the last one', async () => {
    const { net, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: committed('haan') },
    ]);
    await session.write(frame(1, 400));
    await session.forceEndpoint!();
    await session.forceEndpoint!();
    expect(chunks(net).map((chunk) => chunk.commit)).toEqual([false, true]);
    await session.cancel('done');
    net.assertComplete();
  });

  it('commits a silent chunk when the buffer is empty but audio is uncommitted', async () => {
    const { net, session } = await open([{ send: sessionStarted() }, AUDIO, COMMIT]);
    await session.write(frame(7, 400));
    await session.forceEndpoint!();
    const commit = chunks(net)[1]!;
    expect(commit.commit).toBe(true);
    expect(commit.audio).toEqual(new Uint8Array(160).fill(0xff));
    await session.cancel('done');
  });

  it('finalises a throttled commit itself so the next utterance opens a new segment', async () => {
    // Regression: the throttled segment stayed open, the turn detector's ceiling closed it, and
    // every later transcript arrived under that closed id and was dropped.
    const throttled = JSON.stringify({ message_type: 'commit_throttled', error: 'too many' });
    const { events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      { send: partial('main payment') },
      COMMIT,
      { send: throttled },
      AUDIO,
      // The provider still holds the refused audio, so its next transcripts repeat that text.
      { send: partial('main payment') },
      { send: partial('main payment kab tak') },
      COMMIT,
      { send: committed('main payment kab tak hoga') },
      AUDIO,
      { send: partial('aur kuch') },
    ]);
    await session.write(frame(1, 400));
    await session.forceEndpoint!();
    await session.write(frame(2, 400));
    await session.forceEndpoint!();
    await session.write(frame(3, 400));
    expect(transcripts(events)).toEqual([
      '0:interim:main payment',
      '0:final:main payment',
      'end-of-turn',
      '1:interim:kab tak',
      '1:final:kab tak hoga',
      'end-of-turn',
      '2:interim:aur kuch',
    ]);
    await session.cancel('done');
  });

  it('keeps a later transcript whole when it does not repeat the throttled text', async () => {
    const throttled = JSON.stringify({ message_type: 'commit_throttled', error: 'too many' });
    const { events, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      { send: partial('haan') },
      COMMIT,
      { send: throttled },
      AUDIO,
      COMMIT,
      { send: committed('Haan ji') },
    ]);
    await session.write(frame(1, 400));
    await session.forceEndpoint!();
    await session.write(frame(2, 400));
    await session.forceEndpoint!();
    expect(transcripts(events)).toEqual([
      '0:interim:haan',
      '0:final:haan',
      'end-of-turn',
      '1:final:Haan ji',
      'end-of-turn',
    ]);
    await session.cancel('done');
  });

  it('sends 16 kHz PCM with its sample rate', async () => {
    const { net, session } = await open([{ send: sessionStarted() }, AUDIO], PCM16_16K);
    await session.write(new Uint8Array(1_600));
    expect(chunks(net).map((chunk) => [chunk.sample_rate, chunk.audio.byteLength])).toEqual([
      [16000, 1_600],
    ]);
    await session.cancel('done');
  });
});

describe('Scribe finish, failures and usage', () => {
  it('finish commits trailing audio, waits for its transcript and closes normally', async () => {
    const { net, events, usage, session } = await open([
      { send: sessionStarted('scribe-42') },
      AUDIO,
      COMMIT,
      { send: committed('theek hai') },
    ]);
    await session.write(frame(1, 4_000));
    await session.finish();
    expect(transcripts(events)).toEqual(['0:final:theek hai', 'end-of-turn']);
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close', data: '1000 ' });
    // Half a second of 8 kHz mu-law, metered once as audio seconds under the provider session.
    expect(usage).toEqual([
      expect.objectContaining({
        provider: 'elevenlabs',
        operation: 'stt',
        unit: 'audio_seconds',
        quantity: '0.5',
        state: 'estimated',
        requestId: 'scribe-42',
      }),
    ]);
    await expect(session.write(frame(1))).rejects.toThrow(/no longer writable/);
    net.assertComplete();
  });

  it('finish gives up on a missing committed transcript after its deadline', async () => {
    const { clock, net, session } = await open([{ send: sessionStarted() }, AUDIO, COMMIT]);
    await session.write(frame(1, 400));
    let finished = false;
    const finishing = session.finish().then(() => (finished = true));
    await clock.advanceAsync(FINISH_TIMEOUT_MS - 1);
    expect(finished).toBe(false);
    await clock.advanceAsync(1);
    await finishing;
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close' });
  });

  it('finish stops waiting once the provider refuses the trailing commit', async () => {
    // Regression: a throttled commit gets no transcript, so finish sat out its full deadline.
    const { net, session } = await open([
      { send: sessionStarted() },
      AUDIO,
      COMMIT,
      { send: JSON.stringify({ message_type: 'commit_throttled', error: 'too many commits' }) },
    ]);
    await session.write(frame(1, 400));
    await session.finish();
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close', data: '1000 ' });
    net.assertComplete();
  });

  it('a mid-call close surfaces on the next write as a retryable typed failure', async () => {
    const { session, usage } = await open([
      { send: sessionStarted() },
      AUDIO,
      { close: { code: 1011, reason: 'internal' } },
    ]);
    await session.write(frame(1, 400));
    await Promise.resolve();
    await expect(session.write(frame(1))).rejects.toMatchObject({
      name: 'ElevenLabsSttError',
      code: 1011,
      retryable: true,
    });
    expect(usage).toHaveLength(1);
  });

  it('maps provider error messages to typed failures and keeps notices non-fatal', async () => {
    const { session, events } = await open([
      { send: sessionStarted() },
      AUDIO,
      {
        send: JSON.stringify({ message_type: 'commit_throttled', error: 'too many commits' }),
      },
      { send: partial('ek') },
      { send: JSON.stringify({ message_type: 'rate_limited', error: 'slow down' }) },
    ]);
    await session.write(frame(1, 400));
    await Promise.resolve();
    expect(transcripts(events)).toEqual(['0:interim:ek']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('stt_provider_notice'));
    await expect(session.write(frame(1))).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('rejects the handshake on an auth error without a retry', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      script([{ send: JSON.stringify({ message_type: 'auth_error', error: 'bad key' }) }]),
      { clock },
    );
    const usage: UsageMeter[] = [];
    await expect(
      new ElevenLabsStt(net, 'fixture-key', {}, clock).start({
        sessionId: 'scribe-auth',
        format: MULAW_8K,
        language: 'en-IN',
        signal: new AbortController().signal,
        onEvent: () => undefined,
        onUsage: (meter) => usage.push(meter),
      }),
    ).rejects.toMatchObject({ code: 'auth_error', retryable: false });
    expect(net.log.filter((entry) => entry.kind === 'ws-open')).toHaveLength(1);
    expect(usage).toMatchObject([{ quantity: '0', requestId: 'elevenlabs:scribe-auth:1' }]);
  });

  it('fails a transcript that arrives before session_started as a protocol error', async () => {
    const net = createFixtureNet(script([{ send: partial('early') }]));
    await expect(
      new ElevenLabsStt(net, 'fixture-key').start({
        sessionId: 'scribe-early',
        format: MULAW_8K,
        language: 'en',
        signal: new AbortController().signal,
        onEvent: () => undefined,
        onUsage: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'protocol', retryable: false });
  });
});
