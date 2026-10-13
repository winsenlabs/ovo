import { FakeClock } from '@winsendotai/ovo-conformance';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  CARTESIA_MANUAL_CAPABILITIES,
  CartesiaManualStt,
  FINISH_TIMEOUT_MS,
  KEEPER_GAP_MS,
  type CartesiaManualBinding,
} from '../src/index.ts';
import { fakeNet, finals, recorder, settle, speech } from './support.ts';

const REQUEST = '2ff8af53-4d38-479d-8287-58940f01c701';

async function started(binding: CartesiaManualBinding = {}, overrides = {}) {
  const clock = new FakeClock();
  const net = fakeNet();
  const rec = recorder(overrides);
  const stt = new CartesiaManualStt(net, 'fixture-key', binding, clock);
  const session = await stt.start(rec.input);
  return { clock, rec, session, socket: net.sockets[0]! };
}

const transcript = (text: string, isFinal: boolean, extra: Record<string, unknown> = {}) => ({
  type: 'transcript',
  is_final: isFinal,
  text,
  request_id: REQUEST,
  ...extra,
});

describe('Cartesia Manual STT connection (C6)', () => {
  it('connects to /stt/websocket with ink-2 and keyterms, no language parameter', async () => {
    const net = fakeNet();
    const stt = new CartesiaManualStt(
      net,
      'fixture-key',
      { keyterms: ['Fanpit'] },
      new FakeClock(),
      {
        keyterms: ['EMI'],
      },
    );
    await stt.start(recorder({ language: 'hi-IN' }).input);
    expect(net.sockets[0]!.url).toBe(
      'wss://api.cartesia.ai/stt/websocket?model=ink-2&encoding=pcm_mulaw&sample_rate=8000' +
        '&cartesia_version=2026-08-14&keyterm=Fanpit&keyterm=EMI',
    );
    expect(net.sockets[0]!.headers).toEqual({ 'X-API-Key': 'fixture-key' });
  });

  it('ink-whisper sends its pinned language and silence settings, and no keyterms', async () => {
    const net = fakeNet();
    const stt = new CartesiaManualStt(
      net,
      'fixture-key',
      { model: 'ink-whisper', language: 'ta', minVolume: 0.2, maxSilenceDurationSecs: 1.5 },
      new FakeClock(),
      { keyterms: ['ignored'] },
    );
    await stt.start(recorder({ language: 'ta-IN' }).input);
    expect(net.sockets[0]!.url).toBe(
      'wss://api.cartesia.ai/stt/websocket?model=ink-whisper&encoding=pcm_mulaw&sample_rate=8000' +
        '&cartesia_version=2026-08-14&language=ta&min_volume=0.2&max_silence_duration_secs=1.5',
    );
  });

  it('ink-whisper rules: language required and pinned, no keyterms; ink-2 takes none of them', async () => {
    const net = fakeNet();
    const make = (binding: CartesiaManualBinding) =>
      new CartesiaManualStt(net, 'k', binding, new FakeClock());
    expect(() => make({ model: 'ink-whisper' })).toThrow(/language/);
    expect(() => make({ model: 'ink-whisper', language: 'xx' })).toThrow(/language/);
    expect(() => make({ model: 'ink-whisper', language: 'ta', keyterms: ['a'] })).toThrow(
      /ink-2 only/,
    );
    expect(() => make({ language: 'hi' })).toThrow(/ink-whisper only/);
    expect(() => make({ minVolume: 0.5 })).toThrow(/ink-whisper only/);
    const whisper = make({ model: 'ink-whisper', language: 'ta' });
    // A session in another language would be heard as Tamil: refused before connecting.
    await expect(whisper.start(recorder({ language: 'hi-IN' }).input)).rejects.toThrow(/pinned/);
    await expect(make({}).start(recorder({ language: 'ta-IN' }).input)).rejects.toThrow(/ink-2/);
    expect(net.sockets).toHaveLength(0);
  });

  it('declares forceEndpoint, word timestamps and per-model languages for the compat check', () => {
    expect(CARTESIA_MANUAL_CAPABILITIES).toMatchObject({
      forceEndpoint: true,
      wordTimestamps: true,
      turnSignals: [],
    });
    expect(CARTESIA_MANUAL_CAPABILITIES.bindingLanguages.by['ink-whisper']).toEqual(
      expect.arrayContaining(['ta', 'te', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur']),
    );
    expect(CARTESIA_MANUAL_CAPABILITIES.bindingLanguages.by['ink-2']).toEqual([
      'en',
      'fr',
      'hi',
      'ja',
      'es',
    ]);
  });
});

describe('Cartesia Manual STT finalize (C6)', () => {
  it('joins the is_final deltas of one finalize verbatim into ONE final at flush_done', async () => {
    const { socket, session, rec } = await started();
    await session.write(speech(100));
    socket.reply(transcript('Insert', false));
    await session.forceEndpoint();
    expect(socket.texts).toEqual(['finalize']);
    socket.reply(
      transcript('Insert', true, {
        duration: 0.4,
        language: 'en',
        words: [{ word: 'Insert', start: 0.1, end: 0.4 }],
      }),
    );
    socket.reply(
      transcript('ing the card.', true, {
        words: [
          { word: 'ing', start: 0.4, end: 0.5 },
          { word: 'the', start: 0.55, end: 0.7 },
          { word: 'card.', start: 0.75, end: 1.1 },
        ],
      }),
    );
    expect(finals(rec.events)).toEqual([]);
    socket.reply({ type: 'flush_done', request_id: REQUEST });
    const transcripts = rec.events.flatMap((event) =>
      event.type === 'transcript' ? [event.segment] : [],
    );
    expect(transcripts.map((segment) => [segment.text, segment.stability])).toEqual([
      ['Insert', 'interim'],
      ['Inserting the card.', 'interim'],
      ['Inserting the card.', 'final'],
    ]);
    expect(transcripts.at(-1)).toMatchObject({
      segmentId: 'ink-1',
      language: 'en',
      startMs: 100,
      endMs: 1100,
      words: [
        { text: 'Insert', startMs: 100, endMs: 400, final: true },
        { text: 'ing', startMs: 400, endMs: 500, final: true },
        { text: 'the', startMs: 550, endMs: 700, final: true },
        { text: 'card.', startMs: 750, endMs: 1100, final: true },
      ],
    });
    // The next utterance is a new segment.
    await session.write(speech(100));
    socket.reply(transcript('Yes', false));
    expect(rec.events.at(-1)).toMatchObject({ segment: { segmentId: 'ink-2', text: 'Yes' } });
  });

  it('shows a non-final delta after the held finals as one interim', async () => {
    const { socket, session, rec } = await started();
    await session.write(speech(100));
    await session.forceEndpoint();
    socket.reply(transcript('My number', true));
    socket.reply(transcript(' is nine', false));
    expect(rec.events.at(-1)).toMatchObject({
      segment: { text: 'My number is nine', stability: 'interim' },
    });
  });

  it('sends finalize only after new caller audio, and behind the audio written before it', async () => {
    const { clock, socket, session } = await started();
    await session.forceEndpoint();
    expect(socket.sent).toEqual([]);
    await session.write(speech(150));
    await session.forceEndpoint();
    // 100 ms went out; the 50 ms remainder is flushed ahead of the command (paced, 25 ms later).
    expect(socket.sent.map((f) => (typeof f === 'string' ? f : f.byteLength))).toEqual([800]);
    clock.advance(25);
    expect(socket.sent.map((f) => (typeof f === 'string' ? f : f.byteLength))).toEqual([
      800,
      400,
      'finalize',
    ]);
    await session.forceEndpoint();
    expect(socket.texts).toEqual(['finalize']);
  });

  it('keeper silence does not count as new audio for finalize', async () => {
    const { clock, socket, session } = await started();
    clock.advance(KEEPER_GAP_MS + 300);
    expect(socket.audio.length).toBeGreaterThan(0);
    expect(socket.audio.every((frame) => frame.every((byte) => byte === 0xff))).toBe(true);
    await session.forceEndpoint();
    expect(socket.texts).toEqual([]);
  });

  it('finish finalizes the unfinalized audio, then closes after flush_done and ends at done', async () => {
    const { socket, session, rec } = await started();
    await session.write(speech(100));
    let done = false;
    const finishing = session.finish().then(() => (done = true));
    await settle();
    expect(socket.texts).toEqual(['finalize']);
    socket.reply(transcript('Bye now.', true));
    socket.reply({ type: 'flush_done', request_id: REQUEST });
    expect(socket.texts).toEqual(['finalize', 'close']);
    expect(done).toBe(false);
    socket.reply({ type: 'done', request_id: REQUEST });
    await finishing;
    expect(finals(rec.events)).toEqual(['Bye now.']);
    expect(rec.usage).toEqual([
      expect.objectContaining({
        provider: 'cartesia-manual',
        requestId: REQUEST,
        quantity: '0.1',
        unit: 'audio_seconds',
      }),
    ]);
    expect(socket.closedWith).toBe(1000);
  });

  it('a finish that never sees flush_done still delivers the held words at the deadline', async () => {
    const { clock, socket, session, rec } = await started();
    await session.write(speech(100));
    const finishing = session.finish();
    await settle();
    socket.reply(transcript('Call me tomorrow', true));
    await settle();
    clock.advance(FINISH_TIMEOUT_MS);
    await finishing;
    expect(finals(rec.events)).toEqual(['Call me tomorrow']);
    expect(rec.usage).toHaveLength(1);
  });

  it('cancel drops what is held: no final, usage once', async () => {
    const { socket, session, rec } = await started();
    await session.write(speech(100));
    await session.forceEndpoint();
    socket.reply(transcript('half a sent', true));
    await session.cancel('barge-in');
    expect(finals(rec.events)).toEqual([]);
    expect(rec.usage).toEqual([
      expect.objectContaining({ provider: 'cartesia-manual', requestId: REQUEST }),
    ]);
    expect(socket.closedWith).toBe(1000);
  });
});

describe('Cartesia STT silence keeper on a live session (C6)', () => {
  it('writes μ-law 0xFF after 200 ms without caller audio and meters it', async () => {
    const { clock, socket, session, rec } = await started({}, { format: MULAW_8K });
    await session.write(speech(100));
    clock.advance(KEEPER_GAP_MS - 1);
    expect(socket.audio).toHaveLength(1);
    clock.advance(1);
    // The 200 ms gap as two 100 ms frames, the second paced 50 ms behind the first.
    expect(socket.audio).toHaveLength(2);
    clock.advance(50);
    expect(socket.audio).toHaveLength(3);
    expect(socket.audio.slice(1).every((frame) => frame.every((byte) => byte === 0xff))).toBe(true);
    await session.write(speech(100));
    clock.advance(50);
    expect(socket.audio).toHaveLength(4);
    expect(socket.audio[3]![0]).toBe(0x2a);
    await session.cancel('done');
    // No provider request id arrived: the synthetic one names the definition's provider.
    expect(rec.usage[0]).toMatchObject({
      provider: 'cartesia-manual',
      quantity: '0.4',
      requestId: 'cartesia-manual:call-1:1',
    });
  });
});
