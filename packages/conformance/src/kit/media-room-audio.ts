import {
  CALLER_TONE,
  OPERATOR_TONE,
  sleep,
  waitFor,
  withFixture,
  type MediaRoomKitContext,
} from './media-room-fixture.ts';
import { ToneListener } from '../drivers/tone.ts';
import type { RoomDataMessage } from '../drivers/media-room-types.ts';
import type { KitCheck } from './runner.ts';

/** Audio and data between the seat and the participants. */
export const AUDIO_CHECKS: readonly KitCheck<MediaRoomKitContext>[] = [
  {
    name: 'audio flows both ways in whole 20 ms frames',
    timeoutMs: 20_000,
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const operator = await fx.operator(room);
        await waitFor(() => seat.operatorPresent(), fx.deliveryMs);
        const atOperator = new ToneListener(fx.format);
        const atSeat = new ToneListener(fx.format);
        const sizes = new Set<number>();
        operator.onAudio((frame, from) => {
          atOperator.push(frame);
          sizes.add(frame.length);
          if (from !== 'caller') sizes.add(-1);
        });
        seat.onOperatorAudio((frame) => {
          atSeat.push(frame);
          sizes.add(frame.length);
        });
        const callerSide = fx.play(CALLER_TONE, 1_200, (frame) => seat.sendAudio(frame));
        const operatorSide = fx.play(OPERATOR_TONE, 1_200, (frame) => operator.sendAudio(frame));
        await Promise.all([callerSide, operatorSide]);
        await waitFor(
          () =>
            atOperator.heard(CALLER_TONE, [OPERATOR_TONE]) &&
            atSeat.heard(OPERATOR_TONE, [CALLER_TONE]),
          fx.deliveryMs,
        );
        f.expect(
          atOperator.heard(CALLER_TONE, [OPERATOR_TONE]),
          'the operator did not hear the caller tone',
        );
        f.expect(
          atSeat.heard(OPERATOR_TONE, [CALLER_TONE]),
          'the seat did not receive the operator tone',
        );
        f.expect(
          atOperator.frames > 20 && atSeat.frames > 20,
          `too few frames: operator ${atOperator.frames}, seat ${atSeat.frames} of about 60`,
        );
        f.expect(
          [...sizes].every((size) => size === fx.frameBytes),
          `frames are not all ${fx.frameBytes} bytes (20 ms): ${[...sizes].join(', ')}`,
        );
        f.expect(!sizes.has(-1), 'a frame was attributed to someone other than the caller');
        const stats = seat.stats();
        f.expect(stats.framesIn >= 55, `framesIn is ${stats.framesIn}`);
        f.expect(stats.framesOut > 20, `framesOut is ${stats.framesOut}`);
        f.expect(stats.connectedMs > 1_000, `connectedMs is ${stats.connectedMs}`);
      }),
  },
  {
    name: 'the seat never hears its own audio, and a monitor is not an operator',
    timeoutMs: 20_000,
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const heard = new ToneListener(fx.format);
        seat.onOperatorAudio((frame) => heard.push(frame));
        await fx.play(CALLER_TONE, 400, (frame) => seat.sendAudio(frame));
        await sleep(200);
        f.expect(heard.frames === 0, `the seat heard ${heard.frames} frames of its own audio`);
        const monitor = await fx.operator(room, 'mon:u2', 'monitor');
        await waitFor(() => monitor.connected, fx.deliveryMs);
        f.expect(!seat.operatorPresent(), 'a monitor counts as an operator');
        const atMonitor = new ToneListener(fx.format);
        monitor.onAudio((frame) => atMonitor.push(frame));
        await fx.play(CALLER_TONE, 600, (frame) => seat.sendAudio(frame));
        await waitFor(() => atMonitor.heard(CALLER_TONE), fx.deliveryMs);
        f.expect(atMonitor.heard(CALLER_TONE), 'a monitor did not hear the caller');
        let refused = false;
        try {
          monitor.sendAudio(fx.tone(OPERATOR_TONE, 20)[0]!);
        } catch {
          refused = true;
        }
        await sleep(100);
        f.expect(refused || heard.frames === 0, 'a monitor published audio to the seat');
        f.expect(heard.frames === 0, `the seat heard ${heard.frames} frames from a monitor`);
      }),
  },
  {
    name: 'sendAudio never blocks and every frame is counted',
    timeoutMs: 20_000,
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const frame = fx.tone(CALLER_TONE, 20)[0]!;
        const started = Date.now();
        for (let i = 0; i < 2_000; i += 1) seat.sendAudio(frame);
        const took = Date.now() - started;
        f.expect(took < 500, `2000 sendAudio calls took ${took} ms`);
        const stats = seat.stats();
        f.expect(stats.framesIn === 2_000, `framesIn is ${stats.framesIn}, expected 2000`);
        f.expect(
          stats.droppedIn >= 0 && stats.droppedIn <= stats.framesIn,
          `droppedIn ${stats.droppedIn} is out of range`,
        );
        f.expect(stats.droppedIn > 0, 'a flood of 2000 frames was never shed');
      }),
  },
  {
    name: 'data goes to the listed identities only and is capped at 4 KiB',
    run: (ctx) =>
      withFixture(ctx, async (fx, f) => {
        const room = await fx.room();
        const seat = await fx.seat(room);
        const a = await fx.operator(room, 'op:a');
        const b = await fx.operator(room, 'mon:b', 'monitor');
        const got: Record<string, RoomDataMessage[]> = { a: [], b: [] };
        a.onData((m) => got.a!.push(m));
        b.onData((m) => got.b!.push(m));
        await waitFor(() => seat.operatorPresent(), fx.deliveryMs);
        const body = new TextEncoder().encode(JSON.stringify({ text: 'hello' }));
        seat.sendData('ovo.caption', body, ['op:a']);
        f.expect(
          await waitFor(() => got.a!.length === 1, fx.deliveryMs),
          'the addressed participant got no data',
        );
        await sleep(100);
        f.expect(got.b!.length === 0, 'a participant outside the list got the data');
        f.expect(
          got.a![0]!.topic === 'ovo.caption' &&
            got.a![0]!.from === 'caller' &&
            got.a![0]!.payload.length === body.length,
          `the message arrived as ${JSON.stringify({ ...got.a![0], payload: undefined })}`,
        );
        seat.sendData('ovo.caption', body);
        f.expect(
          await waitFor(() => got.a!.length === 2 && got.b!.length === 1, fx.deliveryMs),
          'a broadcast missed someone',
        );
        let threw = false;
        try {
          seat.sendData('ovo.caption', new Uint8Array(4_097));
        } catch {
          threw = true;
        }
        f.expect(threw, 'a message over 4 KiB was accepted');
        let operatorPublished = true;
        try {
          a.sendData('x', body);
        } catch {
          operatorPublished = false;
        }
        f.expect(!operatorPublished, 'an operator published data with a token that forbids it');
      }),
  },
];
