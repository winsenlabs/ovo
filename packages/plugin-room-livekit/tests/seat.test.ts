import { mulawToPcm16, pcm16ToMulaw, toneShare } from '@winsendotai/ovo-audio';
import { MULAW_8K, PCM16_16K, type RoomParticipantEvent } from '@winsendotai/ovo-contracts';
import { AccessToken } from 'livekit-server-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { HeadlessParticipant, sleep, until } from './support/participant.ts';
import { admin, idle, providerFor, roomName, serverOrSkip } from './support/server.ts';

const server = await serverOrSkip('seat.test.ts');
afterAll(() => server?.stop());

const ALPHA = 1000; // the operator speaks this
const BETA = 1800; // the caller speaks this

const mulawFrame = (index: number, freq: number): Uint8Array => {
  const pcm = new Int16Array(160);
  for (let i = 0; i < 160; i += 1)
    pcm[i] = Math.round(10_000 * Math.sin((2 * Math.PI * freq * (index * 160 + i)) / 8000));
  return pcm16ToMulaw(pcm);
};

async function setup(role: 'operator' | 'monitor' = 'operator', identity = 'op:u1') {
  const provider = providerFor(server!);
  const name = roomName();
  await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
  const seat = await provider.join({
    room: name,
    identity: 'caller',
    format: MULAW_8K,
    signal: idle(),
  });
  const { token } = await provider.mintToken({
    room: name,
    identity,
    name: identity,
    role,
    ttlSeconds: 60,
  });
  return { provider, name, seat, token };
}

/** Sends `frames` 20 ms μ-law frames of `freq` in real time. */
async function speak(seat: { sendAudio(frame: Uint8Array): void }, freq: number, frames: number) {
  const started = performance.now();
  for (let i = 0; i < frames; i += 1) {
    seat.sendAudio(mulawFrame(i, freq));
    const wait = started + (i + 1) * 20 - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

describe.skipIf(!server)('RoomSeat against a real server', () => {
  it('carries audio both ways: a tone each way, told apart with a Goertzel detector', async () => {
    const { provider, name, seat, token } = await setup();
    const operator = await HeadlessParticipant.join(server!.url, token);
    const heard: Uint8Array[] = [];
    seat.onOperatorAudio((frame) => heard.push(frame));
    await operator.publishTone(ALPHA);
    await speak(seat, BETA, 150);
    await until(() => heard.length > 60, 5_000, 'operator audio at the seat');

    // Operator → caller: 20 ms μ-law frames, 1000 Hz and nothing at 1800.
    expect(heard.every((frame) => frame.byteLength === 160)).toBe(true);
    const caller = mulawToPcm16(Buffer.concat(heard.slice(25)));
    expect(toneShare(caller, 8000, ALPHA)).toBeGreaterThan(0.9);
    expect(toneShare(caller, 8000, BETA)).toBeLessThan(0.01);
    // Caller → operator: 1800 Hz and nothing at 1000.
    expect(operator.share('caller', BETA)).toBeGreaterThan(0.9);
    expect(operator.share('caller', ALPHA)).toBeLessThan(0.01);

    const stats = seat.stats();
    expect(stats.framesIn).toBeGreaterThanOrEqual(140);
    expect(stats.framesOut).toBeGreaterThan(60);
    expect(stats).toMatchObject({ droppedIn: 0 });
    expect(stats.connectedMs).toBeGreaterThan(1_000);
    await operator.disconnect();
    await seat.close();
    await provider.deleteRoom(name);
  });

  it('reports participants joined and left, replays who is already there, and tracks operatorPresent', async () => {
    const { provider, name, seat, token } = await setup();
    const early: RoomParticipantEvent[] = [];
    seat.onParticipant((event) => early.push(event));
    expect(seat.operatorPresent()).toBe(false);
    expect(early).toEqual([]);

    const operator = await HeadlessParticipant.join(server!.url, token);
    await until(() => early.length === 1, 5_000, 'the operator to be reported');
    expect(early[0]).toEqual({ kind: 'joined', identity: 'op:u1', role: 'operator' });
    expect(seat.operatorPresent()).toBe(true);

    // A listener that arrives late is told about the operator at once.
    const late: RoomParticipantEvent[] = [];
    const unsubscribe = seat.onParticipant((event) => late.push(event));
    expect(late).toEqual([{ kind: 'joined', identity: 'op:u1', role: 'operator' }]);

    await operator.disconnect();
    await until(() => early.length === 2, 5_000, 'the operator to leave');
    expect(early[1]).toEqual({ kind: 'left', identity: 'op:u1', role: 'operator' });
    expect(late[1]).toEqual({ kind: 'left', identity: 'op:u1', role: 'operator' });
    expect(seat.operatorPresent()).toBe(false);

    unsubscribe();
    const again = await HeadlessParticipant.join(server!.url, token);
    await until(() => early.length === 3, 5_000, 'the operator to return');
    expect(late).toHaveLength(2);
    await again.disconnect();
    await seat.close();
    await provider.deleteRoom(name);
  });

  it('is not an operator when it is a monitor or anyone without the op: prefix, and plays only operators', async () => {
    const { provider, name, seat, token } = await setup('monitor', 'mon:sup');
    const events: RoomParticipantEvent[] = [];
    seat.onParticipant((event) => events.push(event));
    const heard: Uint8Array[] = [];
    seat.onOperatorAudio((frame) => heard.push(frame));
    const monitor = await HeadlessParticipant.join(server!.url, token);
    // A stranger who can publish audio, but whose identity is not op:.
    const guestToken = new AccessToken(server!.apiKey, server!.apiSecret, {
      identity: 'guest-1',
      ttl: 60,
    });
    guestToken.addGrant({ room: name, roomJoin: true, canPublish: true, canSubscribe: true });
    const guest = await HeadlessParticipant.join(server!.url, await guestToken.toJwt());
    await guest.publishTone(ALPHA);
    await until(() => events.length === 2, 5_000, 'both to be reported');
    expect(events.map((e) => [e.identity, e.role])).toEqual(
      expect.arrayContaining([
        ['mon:sup', 'monitor'],
        ['guest-1', 'participant'],
      ]),
    );
    expect(seat.operatorPresent()).toBe(false);
    await sleep(1_200);
    expect(heard).toEqual([]);
    await Promise.all([monitor.disconnect(), guest.disconnect()]);
    await seat.close();
    await provider.deleteRoom(name);
  });

  it('sends captions to everyone or only to the named identities, and caps a message at 4 KiB', async () => {
    const { provider, name, seat, token } = await setup();
    const other = (
      await provider.mintToken({
        room: name,
        identity: 'op:u2',
        name: 'u2',
        role: 'operator',
        ttlSeconds: 60,
      })
    ).token;
    const first = await HeadlessParticipant.join(server!.url, token);
    const second = await HeadlessParticipant.join(server!.url, other);
    await until(() => seat.operatorPresent(), 5_000, 'operators');
    const text = (value: string) => new TextEncoder().encode(value);
    seat.sendData('ovo.caption', text('to-all'));
    seat.sendData('ovo.caption', text('only-u1'), ['op:u1']);
    await until(() => first.data.length === 2 && second.data.length === 1, 5_000, 'captions');
    expect(first.data).toEqual([
      { topic: 'ovo.caption', text: 'to-all', from: 'caller' },
      { topic: 'ovo.caption', text: 'only-u1', from: 'caller' },
    ]);
    expect(second.data.map((d) => d.text)).toEqual(['to-all']);
    expect(() => seat.sendData('ovo.caption', new Uint8Array(4097))).toThrow(RangeError);
    seat.sendData('ovo.caption', new Uint8Array(4096));
    await Promise.all([first.disconnect(), second.disconnect()]);
    await seat.close();
    await provider.deleteRoom(name);
  });

  it('never blocks the sender: a flood is dropped past a 300 ms backlog and counted', async () => {
    const { provider, name, seat } = await setup();
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) seat.sendAudio(mulawFrame(i, BETA));
    expect(performance.now() - started).toBeLessThan(500);
    const stats = seat.stats();
    expect(stats.droppedIn).toBeGreaterThan(100);
    expect(stats.framesIn + stats.droppedIn).toBeGreaterThanOrEqual(190);
    expect(stats.framesIn).toBeLessThan(40);
    await seat.close();
    await provider.deleteRoom(name);
  });

  it('counts operator frames that arrive while nobody listens as droppedOut', async () => {
    const { provider, name, seat, token } = await setup();
    const operator = await HeadlessParticipant.join(server!.url, token);
    await operator.publishTone(ALPHA);
    await until(() => seat.stats().droppedOut > 10, 5_000, 'dropped frames');
    expect(seat.stats().framesOut).toBe(0);
    const heard: Uint8Array[] = [];
    seat.onOperatorAudio((frame) => heard.push(frame));
    await until(() => heard.length > 5, 5_000, 'frames once someone listens');
    expect(seat.stats().framesOut).toBe(heard.length);
    await operator.disconnect();
    await seat.close();
    await provider.deleteRoom(name);
  });

  it('survives a throwing listener: others still hear, and the seat stays up', async () => {
    const { provider, name, seat, token } = await setup();
    seat.onOperatorAudio(() => {
      throw new Error('listener bug');
    });
    const heard: Uint8Array[] = [];
    seat.onOperatorAudio((frame) => heard.push(frame));
    const operator = await HeadlessParticipant.join(server!.url, token);
    await operator.publishTone(ALPHA);
    await until(() => heard.length > 10, 5_000, 'frames');
    await operator.disconnect();
    await seat.close();
    await provider.deleteRoom(name);
  });

  it('close is idempotent, freezes the stats, drops what is sent afterwards and leaves the room', async () => {
    const { provider, name, seat, token } = await setup();
    const operator = await HeadlessParticipant.join(server!.url, token);
    await until(() => seat.operatorPresent(), 5_000, 'the operator');
    await Promise.all([seat.close(), seat.close()]);
    await seat.close();
    const frozen = seat.stats();
    await sleep(120);
    expect(seat.stats().connectedMs).toBe(frozen.connectedMs);
    seat.sendAudio(mulawFrame(0, BETA));
    expect(seat.stats().droppedIn).toBe(frozen.droppedIn + 1);
    seat.sendData('t', new Uint8Array(1));
    expect(seat.operatorPresent()).toBe(false);
    await until(
      () => !operator.room.remoteParticipants.has('caller'),
      5_000,
      'the caller to leave',
    );
    expect((await admin(server!).listParticipants(name)).map((p) => p.identity)).toEqual(['op:u1']);
    await operator.disconnect();
    await provider.deleteRoom(name);
  });

  it('closes when the room is deleted under it, telling listeners the operator is gone', async () => {
    const { provider, name, seat, token } = await setup();
    const events: RoomParticipantEvent[] = [];
    seat.onParticipant((event) => events.push(event));
    const operator = await HeadlessParticipant.join(server!.url, token);
    await until(() => events.length === 1, 5_000, 'the operator');
    await provider.deleteRoom(name);
    await until(() => events.length === 2, 5_000, 'the room to close');
    expect(events[1]).toMatchObject({ kind: 'left', identity: 'op:u1' });
    expect(seat.operatorPresent()).toBe(false);
    await operator.disconnect();
    await seat.close();
  });

  it('refuses a format with no conversion before touching the network', async () => {
    const provider = providerFor(server!);
    const started = Date.now();
    await expect(
      provider.join({
        room: roomName(),
        identity: 'caller',
        format: { ...PCM16_16K, sampleRate: 22_050 },
        signal: idle(),
      }),
    ).rejects.toThrow(/No conversion/);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('refuses a seat that would pass as an operator, and a room that does not exist', async () => {
    const provider = providerFor(server!);
    await expect(
      provider.join({ room: roomName(), identity: 'op:fake', format: MULAW_8K, signal: idle() }),
    ).rejects.toThrow(/identity/);
    await expect(
      provider.join({
        room: roomName('uncreated'),
        identity: 'caller',
        format: MULAW_8K,
        signal: idle(),
      }),
    ).rejects.toThrow();
  });

  it('stops connecting when the signal aborts, and closes the seat when it aborts later', async () => {
    const provider = providerFor(server!);
    const name = roomName();
    await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
    await expect(
      provider.join({
        room: name,
        identity: 'caller',
        format: MULAW_8K,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    expect(await admin(server!).listParticipants(name)).toEqual([]);

    const controller = new AbortController();
    const seat = await provider.join({
      room: name,
      identity: 'caller',
      format: MULAW_8K,
      signal: controller.signal,
    });
    expect((await admin(server!).listParticipants(name)).map((p) => p.identity)).toEqual([
      'caller',
    ]);
    controller.abort();
    await until(() => seat.stats().connectedMs >= 0 && seat.operatorPresent() === false, 1_000);
    await sleep(300);
    seat.sendAudio(mulawFrame(0, BETA));
    expect(seat.stats().droppedIn).toBe(1);
    await provider.deleteRoom(name);
  });
});
