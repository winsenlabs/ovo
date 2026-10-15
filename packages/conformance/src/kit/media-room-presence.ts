import {
  CALLER_TONE,
  events,
  sleep,
  unique,
  waitFor,
  withFixture,
  type MediaRoomKitContext,
} from './media-room-fixture.ts';
import type { KitCheck } from './runner.ts';

/** Who is in a room, how the seat is told, and how rooms end. */
export const PRESENCE_CHECKS: readonly KitCheck<MediaRoomKitContext>[] = [
  {
    name: 'the seat sees an operator join and leave, with their role',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const { seen } = events(seat);
        f.expect(!seat.operatorPresent(), 'an operator is present in an empty room');
        const operator = await fx.operator(room);
        f.expect(
          await waitFor(() => seat.operatorPresent(), fx.deliveryMs),
          'operatorPresent never became true',
        );
        f.expect(
          seen.some((e) => e.kind === 'joined' && e.identity === 'op:u1' && e.role === 'operator'),
          `no joined event for the operator: ${JSON.stringify(seen)}`,
        );
        await operator.close();
        f.expect(
          await waitFor(() => !seat.operatorPresent(), fx.deliveryMs),
          'operatorPresent never became false',
        );
        f.expect(
          seen.some((e) => e.kind === 'left' && e.identity === 'op:u1'),
          `no left event for the operator: ${JSON.stringify(seen)}`,
        );
        const [joined, left] = [
          seen.findIndex((e) => e.kind === 'joined'),
          seen.findIndex((e) => e.kind === 'left'),
        ];
        f.expect(joined >= 0 && left > joined, 'left was reported before joined');
      }),
  },
  {
    name: 'a listener added late is told about participants already present, first',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        await fx.operator(room);
        await waitFor(() => seat.operatorPresent(), fx.deliveryMs);
        const { seen } = events(seat);
        f.expect(
          seen.length >= 1 && seen[0]!.kind === 'joined' && seen[0]!.identity === 'op:u1',
          `a late listener saw ${JSON.stringify(seen)} instead of the present operator`,
        );
      }),
  },
  {
    name: 'a second connection with an identity replaces the first',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const first = await fx.operator(room);
        await waitFor(() => seat.operatorPresent(), fx.deliveryMs);
        const gone = new Promise<string>((resolve) => first.onDisconnected(resolve));
        const second = await fx.operator(room);
        const reason = await Promise.race([gone, sleep(fx.deliveryMs).then(() => 'timeout')]);
        f.expect(reason !== 'timeout', 'the first connection with the identity was not dropped');
        f.expect(second.connected, 'the second connection is not connected');
        f.expect(
          await waitFor(() => seat.operatorPresent(), fx.deliveryMs),
          'the operator is not present after replacing',
        );
      }),
  },
  {
    name: 'removeParticipant disconnects an operator and the seat is told',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const { seen } = events(seat);
        const operator = await fx.operator(room);
        await waitFor(() => seat.operatorPresent(), fx.deliveryMs);
        const gone = new Promise<string>((resolve) => operator.onDisconnected(resolve));
        await fx.under.room.removeParticipant(room, 'op:u1');
        await fx.under.room
          .removeParticipant(room, 'op:nobody')
          .catch((e) => f.expect(false, `removing an absent participant threw: ${e}`));
        const reason = await Promise.race([gone, sleep(fx.deliveryMs).then(() => 'timeout')]);
        f.expect(reason !== 'timeout', 'the removed participant was never disconnected');
        f.expect(
          await waitFor(() => seen.some((e) => e.kind === 'left'), fx.deliveryMs),
          'the seat was not told the operator left',
        );
        f.expect(!operator.connected, 'the removed client still reports connected');
      }),
  },
  {
    name: 'deleting a room disconnects everyone and silences the seat',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const operator = await fx.operator(room);
        await waitFor(() => seat.operatorPresent(), fx.deliveryMs);
        const gone = new Promise<string>((resolve) => operator.onDisconnected(resolve));
        await fx.under.room.deleteRoom(room);
        const reason = await Promise.race([gone, sleep(fx.deliveryMs).then(() => 'timeout')]);
        f.expect(reason !== 'timeout', 'deleting the room left the operator connected');
        f.expect(!operator.connected, 'the operator still reports connected');
        let threw = false;
        try {
          seat.sendAudio(fx.tone(CALLER_TONE, 20)[0]!);
          seat.sendData('t', new Uint8Array(1));
        } catch {
          threw = true;
        }
        f.expect(!threw, 'a seat in a deleted room threw instead of dropping');
        await seat.close();
      }),
  },
  {
    name: 'join refuses an aborted signal and a room that does not exist',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const aborted = new AbortController();
        aborted.abort();
        const abortedJoin = await fx.under.room
          .join({ room, identity: 'caller', format: fx.format, signal: aborted.signal })
          .then(
            async (seat) => (await seat.close(), true),
            () => false,
          );
        f.expect(!abortedJoin, 'join succeeded with an aborted signal');
        const missing = await fx.under.room
          .join({
            room: unique('no-such-room'),
            identity: 'caller',
            format: fx.format,
            signal: new AbortController().signal,
          })
          .then(
            async (seat) => (await seat.close(), true),
            () => false,
          );
        f.expect(!missing, 'join succeeded for a room that was never ensured');
      }),
  },
  {
    name: 'a room holds no more participants than it was made for',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room(2);
        await fx.seat(room);
        await fx.operator(room, 'op:a');
        const third = await fx.operator(room, 'op:b').then(
          () => true,
          () => false,
        );
        f.expect(!third, 'a third participant joined a room made for two');
      }),
  },
];
