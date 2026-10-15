import {
  CALLER_TONE,
  sleep,
  unique,
  waitFor,
  withFixture,
  type MediaRoomKitContext,
} from './media-room-fixture.ts';
import { ToneListener } from '../drivers/tone.ts';
import type { KitCheck } from './runner.ts';

/** Room lifecycle and the tokens operators join with. */
export const TOKEN_CHECKS: readonly KitCheck<MediaRoomKitContext>[] = [
  {
    name: 'exposes a provider id, a public url and a health answer',
    run: (ctx) =>
      withFixture(ctx, async ({ under }, f) => {
        const { room } = under;
        f.expect(room.provider.length > 0, 'provider is an empty string');
        f.expect(/^wss?:\/\//.test(room.publicUrl), `publicUrl ${room.publicUrl} is not ws(s)://`);
        const health = await room.health(new AbortController().signal);
        f.expect(health.ok === true, `health is not ok: ${JSON.stringify(health)}`);
      }),
  },
  {
    name: 'ensureRoom and deleteRoom are idempotent',
    run: (ctx) =>
      withFixture(ctx, async ({ under }, f) => {
        const name = unique('ovo-hq-kit');
        const make = () =>
          under.room.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
        await make();
        await make().catch((e) => f.expect(false, `a second ensureRoom threw: ${e}`));
        await under.room.deleteRoom(name);
        await under.room
          .deleteRoom(name)
          .catch((e) => f.expect(false, `a second deleteRoom threw: ${e}`));
        await under.room
          .deleteRoom(unique('never-made'))
          .catch((e) => f.expect(false, `deleting a missing room threw: ${e}`));
      }),
  },
  {
    name: 'an operator token is scoped to one room and one identity',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const { token, expiresAt } = await fx.under.room.mintToken({
          room,
          identity: 'op:u1',
          name: 'Asha',
          role: 'operator',
          ttlSeconds: 120,
        });
        const claims = await fx.under.claimsOf(token);
        f.expect(claims.room === room, `token room is ${claims.room}`);
        f.expect(claims.identity === 'op:u1', `token identity is ${claims.identity}`);
        f.expect(claims.canJoin, 'token does not grant joining its room');
        f.expect(
          Math.abs(new Date(expiresAt).getTime() - claims.expiresAtMs) < 2_000,
          `expiresAt ${expiresAt} differs from the token's exp ${new Date(claims.expiresAtMs).toISOString()}`,
        );
        const other = await fx.room();
        const second = await fx.under.room.mintToken({
          room: other,
          identity: 'op:u1',
          name: 'Asha',
          role: 'operator',
          ttlSeconds: 120,
        });
        f.expect(second.token !== token, 'two rooms got the same token');
        f.expect(
          (await fx.under.claimsOf(second.token)).room === other,
          'second token names the wrong room',
        );
      }),
  },
  {
    name: 'an operator token is audio-only, short-lived and carries no admin rights',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const { token } = await fx.under.room.mintToken({
          room,
          identity: 'op:u1',
          name: 'Asha',
          role: 'operator',
          ttlSeconds: 90,
        });
        const c = await fx.under.claimsOf(token);
        f.expect(c.canPublish && c.canSubscribe, 'an operator publishes and subscribes');
        f.expect(!c.canPublishData, 'an operator token must not publish data');
        f.expect(
          !c.roomAdmin && !c.roomCreate && !c.roomList,
          'an operator token carries admin, create or list rights',
        );
        f.expect(!c.hidden, 'an operator is visible in the room');
        if (c.publishSources)
          f.expect(
            c.publishSources.length === 1 && c.publishSources[0] === 'microphone',
            `an operator publishes microphone only, not ${c.publishSources.join(',')}`,
          );
        const ttl = (c.expiresAtMs - Date.now()) / 1_000;
        f.expect(ttl > 80 && ttl <= 91, `ttl is ${ttl.toFixed(1)} s, not about 90 s`);
      }),
  },
  {
    name: 'a monitor token subscribes and cannot publish',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const { token } = await fx.under.room.mintToken({
          room,
          identity: 'mon:u2',
          name: 'Lead',
          role: 'monitor',
          ttlSeconds: 60,
        });
        const c = await fx.under.claimsOf(token);
        f.expect(c.canSubscribe, 'a monitor subscribes');
        f.expect(!c.canPublish, 'a monitor must not publish');
        f.expect(!c.canPublishData, 'a monitor must not publish data');
        f.expect(!c.roomAdmin, 'a monitor is not an admin');
      }),
  },
  {
    name: 'a token that was not minted by the server is refused',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const { token } = await fx.under.room.mintToken({
          room,
          identity: 'op:u1',
          name: 'A',
          role: 'operator',
          ttlSeconds: 60,
        });
        const [head, body, sig] = token.split('.');
        const forged = `${head}.${body}.${sig!.split('').reverse().join('')}`;
        const rejected = await fx.under.claimsOf(forged).then(
          () => false,
          () => true,
        );
        f.expect(rejected, 'a token with a forged signature verified');
        const joined = await fx.under.connect({ token: forged, room, format: fx.format }).then(
          async (client) => (await client.close(), true),
          () => false,
        );
        f.expect(!joined, 'a forged token joined the room');
      }),
  },
  {
    name: 'a token opens its own room and no other',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const a = await fx.room();
        const b = await fx.room();
        const { token } = await fx.under.room.mintToken({
          room: a,
          identity: 'op:u1',
          name: 'A',
          role: 'operator',
          ttlSeconds: 60,
        });
        const joined = await fx.under.connect({ token, room: b, format: fx.format }).then(
          async (client) => (await client.close(), true),
          () => false,
        );
        f.expect(!joined, 'a token for one room joined another');
        const own = await fx.under.connect({ token, room: a, format: fx.format }).then(
          async (client) => (await client.close(), true),
          () => false,
        );
        f.expect(own, 'a token did not open its own room');
      }),
  },
  {
    name: 'closing the seat is idempotent and ends delivery',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const operator = await fx.operator(room);
        await waitFor(() => seat.operatorPresent(), fx.deliveryMs);
        const heard = new ToneListener(fx.format);
        operator.onAudio((frame) => heard.push(frame));
        await seat.close();
        await seat.close().catch((e) => f.expect(false, `a second close threw: ${e}`));
        const before = heard.frames;
        for (const frame of fx.tone(CALLER_TONE, 200)) seat.sendAudio(frame);
        await sleep(300);
        f.expect(
          heard.frames === before,
          `the operator heard ${heard.frames - before} frames after the seat closed`,
        );
        const stats = seat.stats();
        const later = seat.stats();
        f.expect(
          later.connectedMs - stats.connectedMs < 50,
          'connectedMs keeps counting after close',
        );
      }),
  },
];
