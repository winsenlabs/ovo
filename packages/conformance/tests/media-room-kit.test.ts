import { AccessToken, TokenVerifier, TrackSource } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import type { RoomSeat } from '@winsendotai/ovo-contracts';
import {
  checkMediaRoom,
  describeMediaRoom,
  FakeMediaRoom,
  fakeMediaRoom,
  goertzel,
  hasTone,
  ToneListener,
  type KitFailure,
  type RoomTokenClaims,
} from '../src/index.ts';
import { MULAW_8K } from '@winsendotai/ovo-contracts';
import { encodeAs, tonePcm16 } from '../src/drivers/audio-gen.ts';

describeMediaRoom('fakeMediaRoom', () => fakeMediaRoom());

const messages = (failures: KitFailure[]) => failures.map((f) => f.message).join('\n');

/** The fake room with one deliberate defect, run through the named part of the kit. */
const check = (room: () => FakeMediaRoom, only: string) =>
  checkMediaRoom(room, {}, { only: [only] });

/** A fake whose tokens carry `video` grants of the test's choosing (always signed by the real SDK). */
class GrantsRoom extends FakeMediaRoom {
  constructor(
    private readonly grants: (role: 'operator' | 'monitor') => Record<string, unknown>,
    private readonly ttl = (n: number) => n,
  ) {
    super({ apiKey: 'k', apiSecret: 's'.repeat(40) });
  }
  override async mintToken(input: Parameters<FakeMediaRoom['mintToken']>[0]) {
    const token = new AccessToken('k', 's'.repeat(40), {
      identity: input.identity,
      name: input.name,
      ttl: this.ttl(input.ttlSeconds),
    });
    token.addGrant({ roomJoin: true, room: input.room, ...this.grants(input.role) });
    return {
      token: await token.toJwt(),
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000).toISOString(),
    };
  }
}
const goodGrants = (role: 'operator' | 'monitor') => ({
  canSubscribe: true,
  canPublish: role === 'operator',
  canPublishSources: role === 'operator' ? [TrackSource.MICROPHONE] : [],
  canPublishData: false,
});

/** Wraps the seat the fake hands out. */
class SeatWrapRoom extends FakeMediaRoom {
  constructor(private readonly wrap: (seat: RoomSeat) => RoomSeat) {
    super();
  }
  override async join(input: Parameters<FakeMediaRoom['join']>[0]) {
    return this.wrap(await super.join(input));
  }
}

describe('checkMediaRoom accepts a correct room', () => {
  it('has no failure on the fake', async () => {
    expect(messages(await checkMediaRoom(() => fakeMediaRoom()))).toBe('');
  }, 120_000);

  it('accepts the grants the contract asks for, built independently of the fake', async () => {
    expect(messages(await check(() => new GrantsRoom(goodGrants), 'token'))).toBe('');
  });
});

describe('checkMediaRoom rejects defective token minting', () => {
  it('flags an operator token that may publish data', async () => {
    const failures = await check(
      () => new GrantsRoom((role) => ({ ...goodGrants(role), canPublishData: true })),
      'audio-only',
    );
    expect(messages(failures)).toMatch(/must not publish data/);
  });

  it('flags a token that carries admin rights', async () => {
    const failures = await check(
      () => new GrantsRoom((role) => ({ ...goodGrants(role), roomAdmin: true })),
      'audio-only',
    );
    expect(messages(failures)).toMatch(/admin, create or list/);
  });

  it('flags a token whose publish sources include a camera', async () => {
    const failures = await check(
      () =>
        new GrantsRoom((role) => ({
          ...goodGrants(role),
          canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
        })),
      'audio-only',
    );
    expect(messages(failures)).toMatch(/microphone only/);
  });

  it('flags a token that lives ten times too long', async () => {
    const failures = await check(() => new GrantsRoom(goodGrants, (n) => n * 10), 'audio-only');
    expect(messages(failures)).toMatch(/ttl is/);
  });

  it('flags a monitor that may publish', async () => {
    const failures = await check(
      () =>
        new GrantsRoom((role) => ({
          ...goodGrants('operator'),
          canPublish: role === 'operator' || true,
        })),
      'monitor token',
    );
    expect(messages(failures)).toMatch(/must not publish/);
  });

  it('flags a token not scoped to its identity', async () => {
    class OtherIdentity extends FakeMediaRoom {
      override async mintToken(input: Parameters<FakeMediaRoom['mintToken']>[0]) {
        return super.mintToken({ ...input, identity: 'someone-else' });
      }
    }
    const failures = await check(() => new OtherIdentity(), 'scoped to one room and one identity');
    expect(messages(failures)).toMatch(/token identity is someone-else/);
  });

  it('flags a verifier that accepts a forged signature', async () => {
    class Lax extends FakeMediaRoom {
      override async claimsOf(token: string): Promise<RoomTokenClaims> {
        const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
        return {
          room: payload.video.room,
          identity: payload.sub,
          issuedAtMs: 0,
          expiresAtMs: payload.exp * 1000,
          canJoin: true,
          canPublish: true,
          canSubscribe: true,
          canPublishData: false,
          roomAdmin: false,
          roomCreate: false,
          roomList: false,
          hidden: false,
        };
      }
    }
    const failures = await check(() => new Lax(), 'not minted by the server');
    expect(messages(failures)).toMatch(/forged signature verified/);
  });
});

describe('checkMediaRoom rejects a defective room', () => {
  it('flags an ensureRoom that is not idempotent', async () => {
    class Strict extends FakeMediaRoom {
      private made = new Set<string>();
      override async ensureRoom(input: Parameters<FakeMediaRoom['ensureRoom']>[0]) {
        if (this.made.has(input.name)) throw new Error('already exists');
        this.made.add(input.name);
        return super.ensureRoom(input);
      }
    }
    expect(messages(await check(() => new Strict(), 'idempotent'))).toMatch(
      /second ensureRoom threw/,
    );
  });

  it('flags a seat that never reports participants', async () => {
    const failures = await check(
      () =>
        new SeatWrapRoom((seat) =>
          Object.assign(Object.create(seat), { onParticipant: () => () => undefined }),
        ),
      'sees an operator join',
    );
    expect(messages(failures)).toMatch(/no joined event/);
  });

  it('flags a seat that is deaf to the operator', async () => {
    const failures = await check(
      () =>
        new SeatWrapRoom((seat) =>
          Object.assign(Object.create(seat), { onOperatorAudio: () => () => undefined }),
        ),
      'audio flows both ways',
    );
    expect(messages(failures)).toMatch(/seat did not receive the operator tone/);
  });

  it('flags a seat that hears itself', async () => {
    const failures = await check(
      () =>
        new SeatWrapRoom((seat) => {
          const listeners = new Set<(frame: Uint8Array) => void>();
          return Object.assign(Object.create(seat), {
            onOperatorAudio: (l: (frame: Uint8Array) => void) => (
              listeners.add(l),
              () => listeners.delete(l)
            ),
            sendAudio: (frame: Uint8Array) => {
              seat.sendAudio(frame);
              for (const l of listeners) l(frame);
            },
          });
        }),
      'never hears its own audio',
    );
    expect(messages(failures)).toMatch(/seat heard \d+ frames of its own audio/);
  });

  it('flags a sendAudio that blocks', async () => {
    const failures = await check(
      () =>
        new SeatWrapRoom((seat) =>
          Object.assign(Object.create(seat), {
            sendAudio: (frame: Uint8Array) => {
              const until = Date.now() + 1;
              while (Date.now() < until);
              seat.sendAudio(frame);
            },
          }),
        ),
      'never blocks',
    );
    expect(messages(failures)).toMatch(/2000 sendAudio calls took/);
  });

  it('flags a seat that miscounts frames', async () => {
    const failures = await check(
      () =>
        new SeatWrapRoom((seat) =>
          Object.assign(Object.create(seat), {
            stats: () => ({ ...seat.stats(), framesIn: 0 }),
          }),
        ),
      'never blocks',
    );
    expect(messages(failures)).toMatch(/framesIn is 0/);
  });

  it('flags data with no size limit', async () => {
    const failures = await check(
      () =>
        new SeatWrapRoom((seat) =>
          Object.assign(Object.create(seat), {
            sendData: (topic: string, payload: Uint8Array, ids?: readonly string[]) =>
              seat.sendData(topic, payload.subarray(0, 100), ids),
          }),
        ),
      'data goes to the listed identities',
    );
    expect(messages(failures)).toMatch(/over 4 KiB was accepted/);
  });

  it('flags a seat that keeps delivering after close', async () => {
    const failures = await check(
      () =>
        new SeatWrapRoom((seat) =>
          Object.assign(Object.create(seat), { close: async () => undefined }),
        ),
      'closing the seat is idempotent',
    );
    expect(messages(failures)).toMatch(/frames after the seat closed/);
  });

  it('flags a join that ignores the abort signal', async () => {
    class Deaf extends FakeMediaRoom {
      override async join(input: Parameters<FakeMediaRoom['join']>[0]) {
        return super.join({ ...input, signal: new AbortController().signal });
      }
    }
    expect(messages(await check(() => new Deaf(), 'join refuses'))).toMatch(/aborted signal/);
  });

  it('flags a room that ignores its participant limit', async () => {
    class Roomy extends FakeMediaRoom {
      override async ensureRoom(input: Parameters<FakeMediaRoom['ensureRoom']>[0]) {
        return super.ensureRoom({ ...input, maxParticipants: 50 });
      }
    }
    expect(messages(await check(() => new Roomy(), 'no more participants'))).toMatch(
      /third participant joined/,
    );
  });
});

describe('the fake room server', () => {
  it('refuses an expired token and a token from another server', async () => {
    const room = fakeMediaRoom({ apiKey: 'k', apiSecret: 'x'.repeat(40) });
    await room.ensureRoom({ name: 'r', maxParticipants: 3, emptyTimeoutSeconds: 10 });
    const stranger = new AccessToken('k', 'y'.repeat(40), { identity: 'a', ttl: 60 });
    stranger.addGrant({ roomJoin: true, room: 'r', canPublish: true, canSubscribe: true });
    await expect(
      room.connect({ token: await stranger.toJwt(), room: 'r', format: MULAW_8K }),
    ).rejects.toThrow();
    const expired = new AccessToken('k', 'x'.repeat(40), { identity: 'a', ttl: 1 });
    expired.addGrant({ roomJoin: true, room: 'r' });
    const jwt = await expired.toJwt();
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await expect(room.connect({ token: jwt, room: 'r', format: MULAW_8K })).rejects.toThrow();
    await room.close();
  });

  it('rejects a ttl outside 1 s to 1 h and reads LiveKit defaults for an ungranted token', async () => {
    const room = fakeMediaRoom();
    for (const ttlSeconds of [0, 3_601, 1.5])
      await expect(
        room.mintToken({ room: 'r', identity: 'a', name: 'a', role: 'operator', ttlSeconds }),
      ).rejects.toThrow(/ttlSeconds/);
    const bare = new AccessToken('devkey', 'devsecret-devsecret-devsecret-devsecret', {
      identity: 'a',
    });
    bare.addGrant({ roomJoin: true, room: 'r' });
    expect(await room.claimsOf(await bare.toJwt())).toMatchObject({
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: false,
    });
    await expect(
      new TokenVerifier('devkey', 'devsecret-devsecret-devsecret-devsecret').verify('nope'),
    ).rejects.toThrow();
  });

  it('reports health and can be taken down', async () => {
    const room = fakeMediaRoom();
    expect(await room.health()).toEqual({ ok: true });
    room.setHealthy(false);
    expect(await room.health()).toEqual({ ok: false, reason: 'fake room server is down' });
  });
});

describe('tone helpers', () => {
  const rate = 8000;
  const tone = (freq: number, amplitude = 12_000) => tonePcm16({ freq, ms: 200, rate, amplitude });

  it('scores a tone at its own frequency and not at others', () => {
    expect(goertzel(tone(440), rate, 440)).toBeGreaterThan(0.1);
    expect(goertzel(tone(440), rate, 880)).toBeLessThan(0.005);
    expect(goertzel(new Int16Array(160), rate, 440)).toBe(0);
    expect(goertzel(new Int16Array(0), rate, 440)).toBe(0);
  });

  it('decides which tone dominates', () => {
    const mix = new Int16Array(tone(440).map((v, i) => v + (tone(880, 3_000)[i] ?? 0)));
    expect(hasTone(mix, rate, 440, [880])).toBe(true);
    expect(hasTone(mix, rate, 880, [440])).toBe(false);
    expect(hasTone(tone(440, 200), rate, 440)).toBe(false);
  });

  it('listens to mu-law frames and forgets old audio', () => {
    const listener = new ToneListener(MULAW_8K, 1);
    const frames = (freq: number, ms: number) => {
      const bytes = encodeAs(MULAW_8K, tonePcm16({ freq, ms, rate }));
      return Array.from({ length: bytes.length / 160 }, (_, i) =>
        bytes.slice(i * 160, (i + 1) * 160),
      );
    };
    for (const frame of frames(440, 400)) listener.push(frame);
    expect(listener.heard(440, [880])).toBe(true);
    expect(listener.heard(880)).toBe(false);
    expect(listener.power(440)).toBeGreaterThan(0.1);
    for (const frame of frames(880, 1_500)) listener.push(frame);
    expect(listener.heard(880, [440])).toBe(true);
    expect(listener.frames).toBe(20 + 75);
  });
});
