import type { AudioFormat, RoomParticipantEvent, RoomSeat } from '@winsendotai/ovo-contracts';
import { bytesPerSecond, MULAW_8K } from '@winsendotai/ovo-contracts';
import { encodeAs, tonePcm16 } from '../drivers/audio-gen.ts';
import type {
  MediaRoomFactory,
  MediaRoomUnderTest,
  RoomDataMessage,
  RoomParticipantClient,
} from '../drivers/media-room-types.ts';
import { ToneListener } from '../drivers/tone.ts';
import { Failures, type KitCheck } from './runner.ts';

export interface MediaRoomKitContext {
  factory: MediaRoomFactory;
  options: MediaRoomKitOptions;
}
export interface MediaRoomKitOptions {
  /** The audio format the seat and the headless participants use. Default 8 kHz mu-law. */
  format?: AudioFormat;
  /** Longest a delivery may take before a check calls it lost. Default 3 s. */
  deliveryMs?: number;
}

export const CALLER_TONE = 440;
export const OPERATOR_TONE = 880;
export const FRAME_MS = 20;

let counter = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (condition()) return true;
    await sleep(10);
  }
  return condition();
}

/** A fixture room with the room server under test, its seat and closers. */
export class Fixture {
  readonly cleanups: (() => Promise<void> | void)[] = [];
  readonly format: AudioFormat;
  readonly deliveryMs: number;
  constructor(
    readonly under: MediaRoomUnderTest,
    options: MediaRoomKitOptions,
  ) {
    this.format = options.format ?? MULAW_8K;
    this.deliveryMs = options.deliveryMs ?? 3_000;
  }

  async room(max = 3): Promise<string> {
    const name = unique('ovo-hq-kit');
    await this.under.room.ensureRoom({ name, maxParticipants: max, emptyTimeoutSeconds: 30 });
    this.cleanups.push(() => this.under.room.deleteRoom(name));
    return name;
  }

  async seat(room: string, identity = 'caller'): Promise<RoomSeat> {
    const seat = await this.under.room.join({
      room,
      identity,
      format: this.format,
      signal: new AbortController().signal,
    });
    this.cleanups.push(() => seat.close());
    return seat;
  }

  async operator(
    room: string,
    identity = 'op:u1',
    role: 'operator' | 'monitor' = 'operator',
    ttlSeconds = 120,
  ): Promise<RoomParticipantClient> {
    const { token } = await this.under.room.mintToken({
      room,
      identity,
      name: identity,
      role,
      ttlSeconds,
    });
    const client = await this.under.connect({ token, room, format: this.format });
    this.cleanups.push(() => client.close());
    return client;
  }

  /** 20 ms frames of a tone in the room's format. */
  tone(freq: number, ms: number): Uint8Array[] {
    const pcm = tonePcm16({ freq, ms, rate: this.format.sampleRate });
    const bytes = encodeAs(this.format, pcm);
    const size = (bytesPerSecond(this.format) * FRAME_MS) / 1000;
    const frames: Uint8Array[] = [];
    for (let at = 0; at + size <= bytes.length; at += size) frames.push(bytes.slice(at, at + size));
    return frames;
  }

  get frameBytes(): number {
    return (bytesPerSecond(this.format) * FRAME_MS) / 1000;
  }

  /** Plays a tone through `send` in real time, one frame per 20 ms. */
  async play(freq: number, ms: number, send: (frame: Uint8Array) => void): Promise<void> {
    for (const frame of this.tone(freq, ms)) {
      send(frame);
      await sleep(FRAME_MS);
    }
  }

  async dispose(): Promise<void> {
    for (const cleanup of this.cleanups.reverse())
      await Promise.resolve(cleanup()).catch(() => undefined);
    await this.under.close().catch(() => undefined);
  }
}

export async function withFixture(
  { factory, options }: MediaRoomKitContext,
  work: (fixture: Fixture, f: Failures) => Promise<void>,
): Promise<string[]> {
  const f = new Failures();
  const fixture = new Fixture(await factory(), options);
  try {
    await work(fixture, f);
  } finally {
    await fixture.dispose();
  }
  return f.messages;
}

export const events = (seat: RoomSeat) => {
  const seen: RoomParticipantEvent[] = [];
  const off = seat.onParticipant((event) => seen.push(event));
  return { seen, off };
};
