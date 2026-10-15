import { AccessToken, TokenVerifier, TrackSource } from 'livekit-server-sdk';
import type { AudioFormat, MediaRoomProvider, RoomSeat } from '@winsendotai/ovo-contracts';
import { FakeRoom } from './media-room-room.ts';
import type {
  MediaRoomUnderTest,
  RoomParticipantClient,
  RoomTokenClaims,
} from './media-room-types.ts';

export type * from './media-room-types.ts';
const MAX_TTL_SECONDS = 3_600;

/**
 * An in-memory room server for host tests: participants join with tokens signed by the real server
 * SDK and checked against its verifier, audio moves in real time at one 20 ms frame per tick per
 * publisher, and participant events and data messages behave as the `MediaRoomProvider` contract
 * says. Frames are carried verbatim, so every participant of a test uses one format.
 */
export class FakeMediaRoom implements MediaRoomUnderTest, MediaRoomProvider {
  readonly provider = 'fake-room';
  readonly publicUrl = 'wss://rooms.fake.test';
  readonly apiKey: string;
  private readonly secret: string;
  private readonly rooms = new Map<string, FakeRoom>();
  private healthy = true;

  get room(): MediaRoomProvider {
    return this;
  }

  constructor(options: { apiKey?: string; apiSecret?: string } = {}) {
    this.apiKey = options.apiKey ?? 'devkey';
    this.secret = options.apiSecret ?? 'devsecret-devsecret-devsecret-devsecret';
  }

  /** Makes `health()` answer not ok (host tests of a down room server). */
  setHealthy(healthy: boolean): void {
    this.healthy = healthy;
  }

  async health(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.healthy ? { ok: true } : { ok: false, reason: 'fake room server is down' };
  }

  async ensureRoom(input: { name: string; maxParticipants: number; emptyTimeoutSeconds: number }) {
    if (!this.rooms.has(input.name))
      this.rooms.set(input.name, new FakeRoom(input.name, input.maxParticipants));
  }

  async deleteRoom(name: string): Promise<void> {
    this.rooms.get(name)?.shutdown('room_deleted');
    this.rooms.delete(name);
  }

  /** Rooms that exist now (for e2e-style assertions). */
  roomNames(): string[] {
    return [...this.rooms.keys()];
  }

  async mintToken(input: {
    room: string;
    identity: string;
    name: string;
    role: 'operator' | 'monitor';
    ttlSeconds: number;
  }) {
    if (
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < 1 ||
      input.ttlSeconds > MAX_TTL_SECONDS
    )
      throw new RangeError(`ttlSeconds is between 1 and ${MAX_TTL_SECONDS}`);
    const token = new AccessToken(this.apiKey, this.secret, {
      identity: input.identity,
      name: input.name,
      ttl: input.ttlSeconds,
    });
    token.addGrant({
      roomJoin: true,
      room: input.room,
      canSubscribe: true,
      canPublish: input.role === 'operator',
      canPublishSources: input.role === 'operator' ? [TrackSource.MICROPHONE] : [],
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    return {
      token: await token.toJwt(),
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000).toISOString(),
    };
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    this.rooms.get(room)?.disconnect(identity, 'removed');
  }

  async join(input: {
    room: string;
    identity: string;
    format: AudioFormat;
    signal: AbortSignal;
  }): Promise<RoomSeat> {
    input.signal.throwIfAborted();
    const room = this.rooms.get(input.room);
    if (!room) throw new Error(`Room ${input.room} does not exist`);
    return room.seat(input.identity, input.signal);
  }

  async claimsOf(token: string): Promise<RoomTokenClaims> {
    const claims = await new TokenVerifier(this.apiKey, this.secret).verify(token);
    const video = (claims.video ?? {}) as Record<string, unknown>;
    // LiveKit: with neither canPublish nor canSubscribe set, both are on; canPublishData defaults on.
    const neither = video.canPublish === undefined && video.canSubscribe === undefined;
    return {
      room: String(video.room ?? ''),
      identity: String(claims.sub ?? ''),
      ...(claims.name ? { name: claims.name } : {}),
      issuedAtMs: (claims.nbf ?? claims.iat ?? 0) * 1_000,
      expiresAtMs: (claims.exp ?? 0) * 1_000,
      canJoin: video.roomJoin === true,
      canPublish: neither || video.canPublish === true,
      canSubscribe: neither || video.canSubscribe === true,
      canPublishData: video.canPublishData === undefined || video.canPublishData === true,
      ...(Array.isArray(video.canPublishSources)
        ? { publishSources: video.canPublishSources.map(String) }
        : {}),
      roomAdmin: video.roomAdmin === true,
      roomCreate: video.roomCreate === true,
      roomList: video.roomList === true,
      hidden: video.hidden === true,
    };
  }

  async connect(input: {
    token: string;
    room: string;
    format: AudioFormat;
  }): Promise<RoomParticipantClient> {
    const claims = await this.claimsOf(input.token);
    if (!claims.canJoin || claims.room !== input.room)
      throw new Error('Token does not grant this room');
    if (claims.expiresAtMs <= Date.now()) throw new Error('Token expired');
    const room = this.rooms.get(input.room);
    if (!room) throw new Error(`Room ${input.room} does not exist`);
    return room.admit(claims);
  }

  async close(): Promise<void> {
    for (const room of this.rooms.values()) room.shutdown('server_closed');
    this.rooms.clear();
  }
}

export const fakeMediaRoom = (options?: { apiKey?: string; apiSecret?: string }) =>
  new FakeMediaRoom(options);
