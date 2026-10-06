import {
  MULAW_8K,
  PCM16_24K,
  type NetFixtureScript,
  type SttEvent,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet, decodeBase64 } from '@winsendotai/ovo-plugin-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAiRealtimeSttPlugin } from '../src/index.ts';
import {
  OpenAiRealtimeStt,
  sessionUpdate,
  type OpenAiRealtimeSttBinding,
} from '../src/provider.ts';
import { FINISH_TIMEOUT_MS } from '../src/session.ts';
import {
  RETRIEVED,
  SOURCE,
  committed,
  completed,
  delta,
  sessionCreated,
  sessionUpdated,
} from '../src/testing.ts';

const OPEN = {
  expect: 'ws-open',
  url: 'wss://api.openai.com/v1/realtime?intent=transcription',
  headers: { authorization: 'Bearer fixture-key' },
} as const;
const UPDATE = { expect: 'ws-send', match: 'json', where: { type: 'session.update' } } as const;
const AUDIO = {
  expect: 'ws-send',
  match: 'json',
  where: { type: 'input_audio_buffer.append' },
  repeat: 'until-next',
} as const;
const COMMIT = {
  expect: 'ws-send',
  match: 'json',
  where: { type: 'input_audio_buffer.commit' },
} as const;

function script(steps: NetFixtureScript['steps']): NetFixtureScript[] {
  return [
    { host: 'api.openai.com', source: SOURCE, retrieved: RETRIEVED, steps: [OPEN, ...steps] },
  ];
}

async function open(
  steps: NetFixtureScript['steps'],
  binding: OpenAiRealtimeSttBinding = {},
  format = MULAW_8K,
) {
  const clock = new FakeClock();
  const net = createFixtureNet(script(steps), { clock });
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  const session = await new OpenAiRealtimeStt(net, 'fixture-key', binding, clock).start({
    sessionId: 'call-1',
    format,
    language: 'hi-IN',
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    onUsage: (meter) => usage.push(meter),
  });
  return { clock, net, events, usage, session };
}

/** The client events the plugin sent, in order. */
function sent(net: ReturnType<typeof createFixtureNet>) {
  return net.log.flatMap((entry) =>
    entry.kind === 'ws-out' && typeof entry.data === 'string'
      ? [JSON.parse(entry.data) as Record<string, unknown>]
      : [],
  );
}

const frame = (byte: number, bytes = 160) => new Uint8Array(bytes).fill(byte);
const transcripts = (events: SttEvent[]) =>
  events.map((event) =>
    event.type === 'transcript'
      ? `${event.segment.segmentId}:${event.segment.stability}:${event.segment.text}`
      : event.type,
  );
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe('the session configuration', () => {
  it('asks for mu-law transcription with manual commits by default', () => {
    expect(sessionUpdate({}, MULAW_8K, 'hi-IN')).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: 'gpt-live-transcribe' },
            turn_detection: null,
          },
        },
      },
    });
  });

  it('pins the language, hints and VAD the binding asks for, in each model family', () => {
    const live = sessionUpdate(
      {
        languageMode: 'session',
        keywords: ['CreditMantri', 'EMI'],
        prompt: 'A loan repayment call.',
        delay: 'low',
        noiseReduction: 'far_field',
      },
      PCM16_24K,
      'hi-IN',
    );
    expect(live.session).toMatchObject({
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: {
            model: 'gpt-live-transcribe',
            languages: ['hi'],
            keywords: ['CreditMantri', 'EMI'],
            prompt: 'A loan repayment call.',
            delay: 'low',
          },
          noise_reduction: { type: 'far_field' },
        },
      },
    });
    const vad = sessionUpdate(
      {
        model: 'gpt-4o-transcribe',
        languageMode: 'session',
        turnDetection: 'server_vad',
        silenceDurationMs: 300,
      },
      MULAW_8K,
      'ta-IN',
    );
    expect(vad.session).toMatchObject({
      audio: {
        input: {
          transcription: { model: 'gpt-4o-transcribe', language: 'ta' },
          turn_detection: { type: 'server_vad', silence_duration_ms: 300 },
        },
      },
    });
  });

  it('refuses provider VAD with gpt-live-transcribe, which supports only manual commits', () => {
    expect(
      () => new OpenAiRealtimeStt(createFixtureNet([]), 'k', { turnDetection: 'semantic_vad' }),
    ).toThrow('manual');
  });

  it('reports provider turn signals only in a VAD mode', () => {
    expect(new OpenAiRealtimeStt(createFixtureNet([]), 'k', {}).capabilities.turnSignals).toEqual(
      [],
    );
    expect(
      new OpenAiRealtimeStt(createFixtureNet([]), 'k', {
        model: 'gpt-4o-mini-transcribe',
        turnDetection: 'server_vad',
      }).capabilities.turnSignals,
    ).toEqual(['speech-start', 'end-of-turn']);
  });
});

describe('manual commit', () => {
  it('streams deltas as interim text, then commits and locks the final on forceEndpoint', async () => {
    const { net, events, session } = await open([
      { send: sessionCreated() },
      UPDATE,
      { send: sessionUpdated() },
      AUDIO,
      { send: delta('item_1', 'main kal') },
      COMMIT,
      { send: committed('item_1') },
      { send: delta('item_1', ' pay karunga') },
      { send: completed('item_1', 'main kal pay karunga') },
      AUDIO,
    ]);
    for (let index = 0; index < 10; index += 1) await session.write(frame(0x10 + index));
    await flush();
    await session.forceEndpoint();
    await flush();
    expect(transcripts(events)).toEqual([
      'item_1:interim:main kal',
      'item_1:interim:main kal pay karunga',
      'item_1:final:main kal pay karunga',
      'end-of-turn',
    ]);
    const commit = sent(net).find((event) => event.type === 'input_audio_buffer.commit');
    expect(commit).toEqual({ type: 'input_audio_buffer.commit', event_id: 'ovo_commit_1' });
    // 200 ms of audio went out in 50 ms appends before the commit, nothing was dropped.
    const audio = sent(net)
      .filter((event) => event.type === 'input_audio_buffer.append')
      .map((event) => decodeBase64(event.audio as string));
    expect(audio.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(1600);
    await session.cancel('done');
  });

  it('pads a commit of less than 100 ms with silence', async () => {
    const { net, session } = await open([
      { send: sessionCreated() },
      UPDATE,
      { send: sessionUpdated() },
      AUDIO,
      COMMIT,
      { send: committed('item_1') },
      { send: completed('item_1', 'haan') },
    ]);
    await session.write(frame(0x22));
    await flush();
    await session.forceEndpoint();
    const appended = sent(net)
      .filter((event) => event.type === 'input_audio_buffer.append')
      .reduce((total, event) => total + decodeBase64(event.audio as string).byteLength, 0);
    expect(appended).toBe(800);
    await session.cancel('done');
  });

  it('never commits when nothing was written since the last commit', async () => {
    const { net, session } = await open([
      { send: sessionCreated() },
      UPDATE,
      { send: sessionUpdated() },
    ]);
    await session.forceEndpoint();
    expect(sent(net).map((event) => event.type)).toEqual(['session.update']);
    await session.cancel('done');
  });

  it('holds audio written before session.updated and sends it after, in order', async () => {
    const { clock, net, session } = await open([
      { send: sessionCreated() },
      UPDATE,
      { delayMs: 500 },
      { send: sessionUpdated() },
      AUDIO,
    ]);
    for (let index = 0; index < 5; index += 1) await session.write(frame(index + 1, 400));
    expect(sent(net).map((event) => event.type)).toEqual(['session.update']);
    await clock.advanceAsync(500);
    const appended = sent(net).filter((event) => event.type === 'input_audio_buffer.append');
    // 250 ms written: five 50 ms appends, each carrying its frame's bytes in the order written.
    expect(appended.map((event) => decodeBase64(event.audio as string)[0])).toEqual([
      1, 2, 3, 4, 5,
    ]);
    await session.cancel('done');
  });
});

describe('finishing and failing', () => {
  it('commits the trailing audio on finish, waits for its transcript and closes normally', async () => {
    const { net, events, usage, session } = await open([
      { send: sessionCreated('sess_42') },
      UPDATE,
      { send: sessionUpdated() },
      AUDIO,
      COMMIT,
      { send: committed('item_1') },
      { send: completed('item_1', 'theek hai') },
    ]);
    for (let index = 0; index < 5; index += 1) await session.write(frame(0x30));
    await flush();
    await session.finish();
    expect(transcripts(events)).toEqual(['item_1:final:theek hai', 'end-of-turn']);
    expect(usage).toEqual([
      expect.objectContaining({
        provider: 'openai',
        operation: 'stt',
        unit: 'audio_seconds',
        quantity: '0.1',
        requestId: 'sess_42',
        state: 'estimated',
      }),
    ]);
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close' });
    await expect(session.write(frame(1))).rejects.toThrow();
  });

  it('stops waiting for a transcript that never comes after the finish deadline', async () => {
    const { clock, usage, session } = await open([
      { send: sessionCreated() },
      UPDATE,
      { send: sessionUpdated() },
      AUDIO,
      COMMIT,
    ]);
    for (let index = 0; index < 5; index += 1) await session.write(frame(0x30));
    await flush();
    const finished = session.finish();
    await clock.advanceAsync(FINISH_TIMEOUT_MS);
    await finished;
    expect(usage).toHaveLength(1);
  });

  it('a provider error about a commit releases the finish; any other error keeps the session', async () => {
    const error = (eventId?: string) =>
      JSON.stringify({
        type: 'error',
        event_id: 'event_err',
        error: {
          type: 'invalid_request_error',
          code: 'input_audio_buffer_commit_empty',
          message: 'buffer too small',
          ...(eventId ? { event_id: eventId } : {}),
        },
      });
    const { session, usage } = await open([
      { send: sessionCreated() },
      UPDATE,
      { send: sessionUpdated() },
      { send: error() },
      AUDIO,
      COMMIT,
      { send: error('ovo_commit_1') },
    ]);
    for (let index = 0; index < 5; index += 1) await session.write(frame(0x30));
    await flush();
    await session.finish();
    expect(usage).toHaveLength(1);
  });

  it('a transcription failure still ends the turn, with no final text', async () => {
    const { events, session } = await open([
      { send: sessionCreated() },
      UPDATE,
      { send: sessionUpdated() },
      AUDIO,
      COMMIT,
      { send: committed('item_1') },
      {
        send: JSON.stringify({
          type: 'conversation.item.input_audio_transcription.failed',
          item_id: 'item_1',
          content_index: 0,
          error: { type: 'transcription_error', code: 'audio_unintelligible', message: 'no' },
        }),
      },
    ]);
    await session.write(frame(0x30, 800));
    await flush();
    await session.forceEndpoint();
    await flush();
    expect(transcripts(events)).toEqual(['end-of-turn']);
    await session.cancel('done');
  });

  it('an error before the configuration is confirmed fails the session', async () => {
    const { session, usage } = await open([
      { send: sessionCreated() },
      UPDATE,
      {
        send: JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', code: 'invalid_value', message: 'bad keyword' },
        }),
      },
    ]);
    await flush();
    await expect(session.write(frame(1))).rejects.toThrow('invalid_value');
    expect(usage).toHaveLength(1);
  });

  it('a dropped socket fails the next write with a retryable close', async () => {
    const { session } = await open([
      { send: sessionCreated() },
      UPDATE,
      { send: sessionUpdated() },
      { close: { code: 1011, reason: 'server error' } },
    ]);
    await flush();
    await expect(session.write(frame(1))).rejects.toMatchObject({ code: 1011, retryable: true });
  });
});

describe('provider VAD', () => {
  it('reports speech start and stop and ends each server-committed turn', async () => {
    const { events, session } = await open(
      [
        { send: sessionCreated() },
        UPDATE,
        { send: sessionUpdated() },
        AUDIO,
        { send: JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'i1' }) },
        { send: JSON.stringify({ type: 'input_audio_buffer.speech_stopped', item_id: 'i1' }) },
        { send: committed('i1') },
        { send: completed('i1', 'yes') },
      ],
      { model: 'gpt-4o-transcribe', turnDetection: 'server_vad' },
    );
    await session.write(frame(0x30, 800));
    await flush();
    expect(transcripts(events)).toEqual([
      'speech-start',
      'speech-end',
      'i1:final:yes',
      'end-of-turn',
    ]);
    await session.cancel('done');
  });

  it('keeps finals in commit order when completions arrive out of order', async () => {
    const { events, session } = await open(
      [
        { send: sessionCreated() },
        UPDATE,
        { send: sessionUpdated() },
        AUDIO,
        { send: committed('i1') },
        { send: committed('i2', 'i1') },
        { send: completed('i2', 'second') },
        { send: completed('i1', 'first') },
      ],
      { model: 'gpt-4o-transcribe', turnDetection: 'server_vad' },
    );
    await session.write(frame(0x30, 800));
    await flush();
    expect(transcripts(events)).toEqual([
      'i1:final:first',
      'end-of-turn',
      'i2:final:second',
      'end-of-turn',
    ]);
    await session.cancel('done');
  });
});

describe('the plugin', () => {
  it('is a session STT for the openai provider with a credential and the documented host', () => {
    const { manifest } = openAiRealtimeSttPlugin;
    expect(manifest).toMatchObject({
      id: '@winsendotai/ovo-stt-openai-realtime',
      kind: 'stt',
      provider: 'openai',
      secretFields: [''],
      runtime: { egressHosts: ['api.openai.com'] },
      meters: [{ key: 'openai.streaming-stt.audio_seconds', unit: 'audio_seconds' }],
    });
  });
});
