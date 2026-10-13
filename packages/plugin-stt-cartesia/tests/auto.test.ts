import { FakeClock } from '@winsendotai/ovo-conformance';
import { PCM16_16K, PCM16_24K } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { CartesiaAutoStt, CartesiaSttError, FINISH_TIMEOUT_MS } from '../src/index.ts';
import { fakeNet, finals, recorder, settle, speech } from './support.ts';

const REQUEST = '2ff8af53-4d38-479d-8287-58940f01c701';

async function started(binding = {}, overrides = {}) {
  const clock = new FakeClock();
  const net = fakeNet();
  const rec = recorder(overrides);
  const stt = new CartesiaAutoStt(net, 'fixture-key', binding, clock, { keyterms: ['Fanpit'] });
  const session = await stt.start(rec.input);
  const socket = net.sockets[0]!;
  return { clock, net, rec, stt, session, socket };
}

describe('Cartesia Auto STT connection (C5)', () => {
  it('connects to /stt/turns/websocket with ink-2, the format, the version and X-API-Key', async () => {
    const { socket } = await started({ endpointing: 'fast', keyterms: ['EMI due'] });
    expect(socket.url).toBe(
      'wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_mulaw&sample_rate=8000' +
        '&cartesia_version=2026-08-14&turn_start_threshold=0.7&turn_eager_end_threshold=0.6' +
        '&turn_end_threshold=0.4&turn_end_timeout_ms=4500&keyterm=EMI%20due&keyterm=Fanpit',
    );
    expect(socket.headers).toEqual({ 'X-API-Key': 'fixture-key' });
  });

  it('sends no turn parameters when the binding leaves them to the provider default', async () => {
    const { socket } = await started({}, { format: PCM16_16K });
    expect(socket.url).toBe(
      'wss://api.cartesia.ai/stt/turns/websocket?model=ink-2&encoding=pcm_s16le&sample_rate=16000' +
        '&cartesia_version=2026-08-14&keyterm=Fanpit',
    );
  });

  it('refuses a language ink-2 cannot transcribe and a non-native format before connecting', async () => {
    const net = fakeNet();
    const stt = new CartesiaAutoStt(net, 'fixture-key', {}, new FakeClock());
    await expect(stt.start(recorder({ language: 'ta-IN' }).input)).rejects.toThrow(/ta-IN/);
    await expect(stt.start(recorder({ format: PCM16_24K }).input)).rejects.toThrow(TypeError);
    expect(net.sockets).toHaveLength(0);
  });

  it('gives up retryably when the handshake does not finish in connectTimeoutMs', async () => {
    const clock = new FakeClock();
    const net = fakeNet(false);
    const stt = new CartesiaAutoStt(net, 'fixture-key', { connectTimeoutMs: 2000 }, clock);
    const rec = recorder();
    const pending = stt.start(rec.input);
    const outcome = pending.catch((error: unknown) => error);
    clock.advance(1999);
    await settle();
    expect(net.sockets[0]!.closedWith).toBeUndefined();
    clock.advance(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(CartesiaSttError);
    expect(error).toMatchObject({ retryable: true, code: 'connect-timeout' });
    expect(net.sockets[0]!.closedWith).toBeDefined();
    expect(rec.usage).toHaveLength(1);
  });
});

describe('Cartesia Auto STT events (C5)', () => {
  it('maps turn.start/update/eager_end/resume/end onto OVO events and segments', async () => {
    const { socket, rec } = await started();
    socket.reply({ type: 'connected', request_id: REQUEST });
    socket.reply({ type: 'turn.start', request_id: REQUEST });
    socket.reply({ type: 'turn.update', transcript: 'Hey can you', request_id: REQUEST });
    socket.reply({ type: 'turn.update', transcript: 'Hey can you', request_id: REQUEST });
    socket.reply({ type: 'turn.eager_end', transcript: 'Hey can you help', request_id: REQUEST });
    socket.reply({ type: 'turn.resume', request_id: REQUEST });
    socket.reply({ type: 'turn.update', transcript: 'Hey can you help me', request_id: REQUEST });
    socket.reply({
      type: 'turn.end',
      transcript: 'Hey can you help me with something?',
      request_id: REQUEST,
    });
    socket.reply({ type: 'turn.start', request_id: REQUEST });
    socket.reply({ type: 'turn.end', transcript: 'Thanks.', request_id: REQUEST });
    expect(rec.events).toEqual([
      { type: 'speech-start' },
      {
        type: 'transcript',
        segment: { segmentId: 'ink-1', revision: 1, text: 'Hey can you', stability: 'interim' },
      },
      {
        type: 'transcript',
        segment: {
          segmentId: 'ink-1',
          revision: 2,
          text: 'Hey can you help',
          stability: 'interim',
        },
      },
      { type: 'end-of-turn', eager: true },
      { type: 'turn-resumed' },
      {
        type: 'transcript',
        segment: {
          segmentId: 'ink-1',
          revision: 3,
          text: 'Hey can you help me',
          stability: 'interim',
        },
      },
      {
        type: 'transcript',
        segment: {
          segmentId: 'ink-1',
          revision: 4,
          text: 'Hey can you help me with something?',
          stability: 'final',
        },
      },
      { type: 'end-of-turn' },
      { type: 'speech-start' },
      {
        type: 'transcript',
        segment: { segmentId: 'ink-2', revision: 5, text: 'Thanks.', stability: 'final' },
      },
      { type: 'end-of-turn' },
    ]);
  });

  it('a turn that ends with no words ends silently', async () => {
    const { socket, rec } = await started();
    socket.reply({ type: 'turn.start' });
    socket.reply({ type: 'turn.end', transcript: '' });
    expect(rec.events).toEqual([{ type: 'speech-start' }]);
  });

  it('sends 100 ms binary frames, then finish sends close and ends when the provider closes', async () => {
    const { clock, socket, session, rec } = await started();
    socket.reply({ type: 'connected', request_id: REQUEST });
    // Live audio: 50 ms written every 50 ms.
    for (let i = 0; i < 5; i += 1) {
      await session.write(speech(50));
      clock.advance(50);
    }
    expect(socket.audio.map((frame) => frame.byteLength)).toEqual([800, 800]);
    const finishing = session.finish();
    await settle();
    // The 50 ms remainder, then the documented close command.
    expect(socket.audio.map((frame) => frame.byteLength)).toEqual([800, 800, 400]);
    expect(socket.texts).toEqual(['{"type":"close"}']);
    socket.reply({ type: 'turn.start' });
    socket.reply({ type: 'turn.end', transcript: 'Last words.' });
    socket.drop(1000);
    await finishing;
    expect(finals(rec.events)).toEqual(['Last words.']);
    expect(rec.usage).toEqual([
      expect.objectContaining({
        provider: 'cartesia',
        operation: 'stt',
        unit: 'audio_seconds',
        quantity: '0.25',
        state: 'estimated',
        requestId: REQUEST,
      }),
    ]);
    await expect(session.write(speech(20))).rejects.toThrow();
  });

  it('keeps an open turn as final when the provider closes before turn.end', async () => {
    const { socket, session, rec } = await started();
    await session.write(speech(100));
    socket.reply({ type: 'turn.start' });
    socket.reply({ type: 'turn.update', transcript: 'my account number is' });
    const finishing = session.finish();
    await settle();
    socket.drop(1000);
    await finishing;
    expect(finals(rec.events)).toEqual(['my account number is']);
  });

  it('ends at the finish deadline when the provider never closes', async () => {
    const { clock, socket, session, rec } = await started();
    await session.write(speech(100));
    let done = false;
    void session.finish().then(() => (done = true));
    await settle();
    clock.advance(FINISH_TIMEOUT_MS - 1);
    await settle();
    expect(done).toBe(false);
    clock.advance(1);
    await settle();
    expect(done).toBe(true);
    expect(socket.closedWith).toBe(1000);
    expect(rec.usage).toHaveLength(1);
  });

  it('cancel closes the socket at once and meters once with a synthetic id', async () => {
    const { socket, session, rec } = await started();
    await session.write(speech(100));
    await session.cancel('barge');
    await session.cancel('again');
    expect(socket.closedWith).toBe(1000);
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0]).toMatchObject({ requestId: 'cartesia:call-1:1', quantity: '0.1' });
    await expect(session.write(speech(20))).rejects.toThrow();
  });
});

describe('Cartesia Auto STT failures (C5)', () => {
  it('a 429 concurrency_limited error is retryable; quota and auth errors are final', async () => {
    for (const [status, code, retryable] of [
      [429, 'concurrency_limited', true],
      [503, null, true],
      [402, 'quota_exceeded', false],
      [401, null, false],
    ] as const) {
      const { socket, session, rec } = await started();
      const finished = session.finish().catch((error: unknown) => error);
      socket.reply({ type: 'error', status_code: status, error_code: code, title: 'x' });
      const error = await finished;
      expect(error, `${status}`).toMatchObject({ name: 'CartesiaSttError', retryable });
      await expect(session.write(speech(20))).rejects.toBe(error);
      expect(rec.usage).toHaveLength(1);
    }
  });

  it('an unexpected close fails the session retryably; a policy close does not', async () => {
    for (const [code, retryable] of [
      [1011, true],
      [1008, false],
    ] as const) {
      const { socket, session } = await started();
      const finished = session.finish().catch((error: unknown) => error);
      socket.drop(code);
      await expect(finished).resolves.toBeUndefined();
      // A drop while finishing ends gracefully; while active it is a failure.
      const again = await started();
      again.socket.drop(code);
      await expect(again.session.write(speech(20))).rejects.toMatchObject({ retryable });
    }
  });
});

describe('Cartesia Auto STT updateConfiguration (C5)', () => {
  it('sends the documented config command for an endpointing preset', async () => {
    const { socket, session } = await started();
    await session.updateConfiguration({ endpointing: 'patient' });
    await session.updateConfiguration({ endpointing: 'fast', maxTurnSilenceMs: 20_000 });
    expect(socket.texts.map((text) => JSON.parse(text))).toEqual([
      {
        type: 'config',
        turn: {
          start_threshold: 0.8,
          eager_end_threshold: 0.3,
          end_threshold: 0.1,
          end_timeout_ms: 8000,
        },
      },
      {
        type: 'config',
        turn: {
          start_threshold: 0.7,
          eager_end_threshold: 0.6,
          end_threshold: 0.4,
          end_timeout_ms: 11_200,
        },
      },
    ]);
  });

  it('keyterm changes are fixed at connect: logged and not sent', async () => {
    const { socket, session } = await started();
    await session.updateConfiguration({ keyterms: ['new term'] });
    await session.updateConfiguration({ vadThreshold: 0.5 });
    expect(socket.texts).toEqual([]);
  });

  it('rejects after the session ended', async () => {
    const { session } = await started();
    await session.cancel('done');
    await expect(session.updateConfiguration({ endpointing: 'fast' })).rejects.toThrow();
  });
});
