import { afterAll, describe, expect, it } from 'vitest';
import { AccessToken } from 'livekit-server-sdk';
import { pickPorts, startLiveKitServer } from '../src/testing.ts';
import { HeadlessParticipant, sleep, until } from './support/participant.ts';
import { admin, idle, providerFor, roomName, serverOrSkip } from './support/server.ts';

const server = await serverOrSkip('provider.test.ts');
afterAll(() => server?.stop());

describe.skipIf(!server)('LiveKitRoomProvider against a real server', () => {
  const rooms = () => admin(server!).listRooms();

  it('ensureRoom creates one room with the limits and is idempotent', async () => {
    const provider = providerFor(server!);
    const name = roomName();
    await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
    await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
    const found = (await rooms()).filter((room) => room.name === name);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ maxParticipants: 3, emptyTimeout: 30 });
    await provider.deleteRoom(name);
  });

  it('refuses an invalid room name before any request', async () => {
    await expect(
      providerFor(server!).ensureRoom({ name: 'a b', maxParticipants: 3, emptyTimeoutSeconds: 30 }),
    ).rejects.toThrow(/room name/);
  });

  it('deleteRoom removes the room and is idempotent for a room that is gone', async () => {
    const provider = providerFor(server!);
    const name = roomName();
    await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
    await provider.deleteRoom(name);
    expect((await rooms()).some((room) => room.name === name)).toBe(false);
    await provider.deleteRoom(name);
    await provider.deleteRoom(roomName('never-created'));
  });

  it('removeParticipant disconnects someone in the room and is idempotent for anyone who is not', async () => {
    const provider = providerFor(server!);
    const name = roomName();
    await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
    const { token } = await provider.mintToken({
      room: name,
      identity: 'op:kick-me',
      name: 'K',
      role: 'operator',
      ttlSeconds: 60,
    });
    const operator = await HeadlessParticipant.join(server!.url, token);
    expect((await admin(server!).listParticipants(name)).map((p) => p.identity)).toEqual([
      'op:kick-me',
    ]);
    await provider.removeParticipant(name, 'op:kick-me');
    await until(() => !operator.room.isConnected, 5_000, 'the operator to be disconnected');
    await provider.removeParticipant(name, 'op:kick-me');
    await provider.removeParticipant(roomName('no-such-room'), 'op:ghost');
    await provider.deleteRoom(name);
  });

  describe('operator tokens as the server enforces them', () => {
    it('joins its own room as an operator and nowhere else', async () => {
      const provider = providerFor(server!);
      const [a, b] = [roomName(), roomName()];
      for (const name of [a, b])
        await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
      const { token } = await provider.mintToken({
        room: a,
        identity: 'op:u1',
        name: 'U One',
        role: 'operator',
        ttlSeconds: 60,
      });
      const joined = await HeadlessParticipant.join(server!.url, token);
      expect((await admin(server!).listParticipants(a)).map((p) => p.identity)).toEqual(['op:u1']);
      expect(await admin(server!).listParticipants(b)).toEqual([]);
      await joined.disconnect();
      // The token names room a; the server places it there whatever the client asks.
      for (const name of [a, b]) await provider.deleteRoom(name);
    });

    it('cannot join a room that was never created: rooms exist only through ensureRoom', async () => {
      const provider = providerFor(server!);
      const { token } = await provider.mintToken({
        room: roomName('uncreated'),
        identity: 'op:u1',
        name: 'U',
        role: 'operator',
        ttlSeconds: 60,
      });
      await expect(HeadlessParticipant.join(server!.url, token)).rejects.toThrow();
    });

    it('a room holds three participants and refuses a fourth', async () => {
      const provider = providerFor(server!);
      const name = roomName();
      await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
      const joined: HeadlessParticipant[] = [];
      for (const id of ['op:a', 'op:b', 'mon:c'])
        joined.push(
          await HeadlessParticipant.join(
            server!.url,
            (
              await provider.mintToken({
                room: name,
                identity: id,
                name: id,
                role: id.startsWith('op') ? 'operator' : 'monitor',
                ttlSeconds: 60,
              })
            ).token,
          ),
        );
      const fourth = (
        await provider.mintToken({
          room: name,
          identity: 'op:d',
          name: 'd',
          role: 'operator',
          ttlSeconds: 60,
        })
      ).token;
      await expect(HeadlessParticipant.join(server!.url, fourth)).rejects.toThrow();
      await Promise.all(joined.map((p) => p.disconnect()));
      await provider.deleteRoom(name);
    });

    it('an operator cannot publish data into the room (canPublishData is false)', async () => {
      const provider = providerFor(server!);
      const name = roomName();
      await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
      const listener = new AccessToken(server!.apiKey, server!.apiSecret, {
        identity: 'listener',
        ttl: 60,
      });
      listener.addGrant({ room: name, roomJoin: true, canSubscribe: true });
      const heard = await HeadlessParticipant.join(server!.url, await listener.toJwt());
      const operator = await HeadlessParticipant.join(
        server!.url,
        (
          await provider.mintToken({
            room: name,
            identity: 'op:u1',
            name: 'U',
            role: 'operator',
            ttlSeconds: 60,
          })
        ).token,
      );
      await operator.room
        .localParticipant!.publishData(Buffer.from('forged'), {
          reliable: true,
          topic: 'ovo.caption',
        })
        .catch(() => undefined);
      await sleep(700);
      expect(heard.data).toEqual([]);
      // Control: a participant that is allowed to publish data does get through.
      const allowed = new AccessToken(server!.apiKey, server!.apiSecret, {
        identity: 'speaker',
        ttl: 60,
      });
      allowed.addGrant({ room: name, roomJoin: true, canPublishData: true });
      const speaker = await HeadlessParticipant.join(server!.url, await allowed.toJwt());
      await speaker.room.localParticipant!.publishData(Buffer.from('ok'), {
        reliable: true,
        topic: 't',
      });
      await until(() => heard.data.length > 0, 5_000, 'the control message');
      expect(heard.data.map((d) => d.text)).toEqual(['ok']);
      await Promise.all([heard, operator, speaker].map((p) => p.disconnect()));
      await provider.deleteRoom(name);
    });
  });

  describe('health', () => {
    it('is ok for a reachable server with a good key', async () => {
      expect(await providerFor(server!).health(idle())).toEqual({ ok: true });
    });

    it('says unauthorized for a key the server does not know, with no secret in the reason', async () => {
      const provider = providerFor(server!, { apiSecret: 'x'.repeat(40) });
      const health = await provider.health(idle());
      expect(health).toEqual({ ok: false, reason: 'unauthorized' });
    });

    it('says unreachable when nothing listens, quickly and without leaking the address', async () => {
      const [port] = await pickPorts(1);
      const provider = providerFor(server!, { url: `ws://127.0.0.1:${port}` });
      const health = await provider.health(idle());
      expect(health).toEqual({ ok: false, reason: 'unreachable' });
    });

    it('caches: a second ask inside the window does not reach the server again', async () => {
      const own = await startLiveKitServer();
      const provider = providerFor(own);
      expect(await provider.health(idle())).toEqual({ ok: true });
      await own.stop();
      expect(await provider.health(idle())).toEqual({ ok: true });
    });
  });
});
