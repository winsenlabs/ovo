import { CarrierProtocolError, MULAW_8K } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  SipMediaCodecSession,
  createSipMediaSerializer,
  createSipRequestVerifier,
  signRequest,
} from '../src/index.ts';
import { createSipFixtureFrameEncoder, signedSipUpgrade } from '../src/testing.ts';

const STREAM = 'st_0b0e8f3c-6f53-4c1a-9a55-0f6d2c3b7e10';
const start = JSON.stringify({
  event: 'start',
  callId: 'c-1',
  streamId: STREAM,
  format: { encoding: 'mulaw', sampleRate: 8000 },
  routeParams: { sid: 's-1', rt: 'rt-1' },
});
const media = (seq: number, payload = '//8=') =>
  JSON.stringify({ event: 'media', seq, tsMs: (seq - 1) * 20, payload });
const started = () => {
  const session = new SipMediaCodecSession();
  session.decode(start);
  return session;
};

describe('SIP media codec session (§5.3)', () => {
  it('decodes the documented frames into carrier events', () => {
    const session = new SipMediaCodecSession();
    expect(session.decode('{"event":"connected","v":1}')).toEqual([{ type: 'connected' }]);
    expect(session.decode(start)).toEqual([
      {
        type: 'start',
        carrierCallId: 'c-1',
        streamId: STREAM,
        format: MULAW_8K,
        routeParams: { sid: 's-1', rt: 'rt-1' },
      },
    ]);
    expect(session.decode(media(1))).toEqual([
      { type: 'audio', seq: 1, timestampMs: 0, payload: new Uint8Array([255, 255]) },
    ]);
    expect(session.decode('{"event":"dtmf","digit":"#","durationMs":120}')).toEqual([
      { type: 'dtmf', digit: '#', durationMs: 120 },
    ]);
    expect(session.decode('{"event":"mark","name":"m42"}')).toEqual([
      { type: 'played', name: 'm42' },
    ]);
    expect(session.decode('{"event":"cleared"}')).toEqual([{ type: 'cleared' }]);
    expect(session.decode('{"event":"stop","reason":"caller-hangup"}')).toEqual([
      { type: 'stop', reason: 'caller-hangup' },
    ]);
  });

  it('maps an unknown stop reason to unknown and refuses frames after stop', () => {
    const session = started();
    expect(session.decode('{"event":"stop","reason":"drain"}')).toEqual([
      { type: 'stop', reason: 'unknown' },
    ]);
    expect(() => session.decode(media(1))).toThrow(CarrierProtocolError);
  });

  it.each([
    ['not JSON', 'nope'],
    ['an unknown event', '{"event":"hello"}'],
    ['an A-law start', start.replace('mulaw', 'alaw')],
    ['a 16 kHz start', start.replace('8000', '16000')],
    ['a start without rt', start.replace('"rt":"rt-1"', '"x":"y"')],
    ['a non-UUID stream id', start.replace(STREAM, 'st_1')],
    ['extra fields', '{"event":"cleared","x":1}'],
  ])('refuses %s', (_label, frame) => {
    expect(() => new SipMediaCodecSession().decode(frame)).toThrow(CarrierProtocolError);
  });

  it('refuses media before start, a second start and connected after start', () => {
    expect(() => new SipMediaCodecSession().decode(media(1))).toThrow(/before start/);
    expect(() => started().decode(start)).toThrow(/Duplicate/);
    expect(() => started().decode('{"event":"connected","v":1}')).toThrow(/after start/);
  });

  it('requires strictly increasing seq', () => {
    const session = started();
    session.decode(media(5));
    expect(() => session.decode(media(5))).toThrow(/seq/);
    expect(() => session.decode(media(4))).toThrow(/seq/);
    expect(session.decode(media(9))).toHaveLength(1);
  });

  it.each([
    ['non-canonical base64', '//8'],
    ['an empty payload', ''],
    ['an 8193-byte payload', Buffer.alloc(8193, 0xff).toString('base64')],
    ['a bad DTMF digit', null],
  ])('refuses %s', (label, payload) => {
    const session = started();
    const frame = payload === null ? '{"event":"dtmf","digit":"E"}' : media(1, payload);
    expect(() => session.decode(frame), label).toThrow(CarrierProtocolError);
  });

  it('accepts an 8192-byte payload', () => {
    const payload = Buffer.alloc(8192, 0x7f).toString('base64');
    expect(started().decode(media(1, payload))[0]).toMatchObject({ type: 'audio' });
  });

  it('encodes commands, splitting audio above 32 KiB, and frames terminate', () => {
    const session = new SipMediaCodecSession();
    expect(session.encode({ type: 'mark', name: 'm1' })).toEqual(['{"event":"mark","name":"m1"}']);
    expect(session.encode({ type: 'clear' })).toEqual(['{"event":"clear"}']);
    expect(session.encode({ type: 'audio', payload: new Uint8Array() })).toEqual([]);
    const frames = session.encode({ type: 'audio', payload: new Uint8Array(32 * 1024 + 1) });
    expect(frames).toHaveLength(2);
    expect(Buffer.from(JSON.parse(frames[1]!).payload, 'base64')).toHaveLength(1);
    expect(session.flush()).toEqual([]);
    expect(session.terminate()).toEqual(['{"event":"terminate"}']);
  });

  it('round-trips the fixture frame encoder', () => {
    const encode = createSipFixtureFrameEncoder();
    const session = new SipMediaCodecSession();
    const events = [
      { type: 'connected' as const },
      {
        type: 'start' as const,
        carrierCallId: 'c-1',
        streamId: STREAM,
        format: MULAW_8K,
        routeParams: { sid: 's', rt: 'r' },
      },
      { type: 'audio' as const, seq: 1, timestampMs: 0, payload: new Uint8Array([1, 2]) },
      { type: 'dtmf' as const, digit: '7' },
      { type: 'played' as const, name: 'm' },
      { type: 'cleared' as const },
      { type: 'stop' as const, reason: 'caller-hangup' as const },
    ];
    expect(events.flatMap((event) => session.decode(encode(event)))).toEqual(events);
  });
});

describe('SIP media upgrade authentication', () => {
  const key = new Uint8Array(32).fill(3);
  const now = 1_760_000_000_000;
  const serializer = (keys = [key]) =>
    createSipMediaSerializer({
      verifier: () => createSipRequestVerifier({ keys, now: () => now }),
    });
  const ctx = {
    bindingId: 'b1',
    resolveBinding: async () => {
      throw new Error('the SIP upgrade never needs the binding');
    },
    verifyUrlSecret: () => false,
  };

  it('accepts a signed wss upgrade', async () => {
    const upgrade = await signedSipUpgrade({ key, carrierId: 'sip', bindingId: 'b1', now });
    expect(await serializer().authenticateUpgrade(upgrade, ctx)).toEqual({ ok: true, params: {} });
  });

  it('refuses a wrong key, a query and an absent verifier', async () => {
    const upgrade = await signedSipUpgrade({ key, carrierId: 'sip', bindingId: 'b1', now });
    expect(await serializer([new Uint8Array(32)]).authenticateUpgrade(upgrade, ctx)).toEqual({
      ok: false,
      status: 401,
    });
    const queried = { ...upgrade, url: new URL(`${upgrade.externalUrl}?sid=1`) };
    expect((await serializer().authenticateUpgrade(queried, ctx)).ok).toBe(false);
    const absent = createSipMediaSerializer({ verifier: () => undefined });
    expect(await absent.authenticateUpgrade(upgrade, ctx)).toEqual({ ok: false, status: 403 });
  });

  it('refuses an upgrade signed for another binding', async () => {
    const externalUrl = 'wss://ovo.example.test/carriers/sip/b1/media';
    const headers = await signRequest({
      key,
      method: 'GET',
      externalUrl: externalUrl.replace('/b1/', '/b2/'),
      body: new Uint8Array(),
      now,
    });
    const result = await serializer().authenticateUpgrade(
      { url: new URL(externalUrl), externalUrl, headers },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});
