import { RoomServiceClient } from 'livekit-server-sdk';
import type { AudioFormat, MediaRoomProvider, RoomSeat } from '@winsendotai/ovo-contracts';
import { httpOrigin, wsOrigin, type RoomConfig } from './config.ts';
import { CachedHealth } from './health.ts';
import { connectSeat, type SeatLogger } from './seat.ts';
import { KeyRing, ROOM_NAME, mintOperatorToken, mintSeatToken, type ApiKeyPair } from './tokens.ts';

const isStatus =
  (...codes: number[]) =>
  (error: unknown) =>
    codes.includes((error as { status?: number } | null)?.status ?? 0);
const isMissing = isStatus(404);
const isUnauthorized = isStatus(401, 403);

export interface ProviderDeps {
  now?: () => number;
  logger?: SeatLogger;
}

/** `MediaRoomProvider` over a self-hosted LiveKit server: REST for rooms, JWTs for joins. */
export class LiveKitRoomProvider implements MediaRoomProvider {
  readonly provider = 'livekit';
  readonly publicUrl: string;
  private readonly ring: KeyRing;
  private readonly clients = new Map<ApiKeyPair, RoomServiceClient>();
  private readonly healthy: CachedHealth;
  private readonly now: () => number;

  constructor(
    private readonly config: RoomConfig,
    private readonly deps: ProviderDeps = {},
  ) {
    this.publicUrl = wsOrigin(config.publicUrl);
    this.now = deps.now ?? Date.now;
    this.ring = new KeyRing(
      { key: config.apiKey, secret: config.apiSecret },
      config.previousApiKey && config.previousApiSecret
        ? { key: config.previousApiKey, secret: config.previousApiSecret }
        : undefined,
    );
    this.healthy = new CachedHealth(
      () => this.api((client) => client.listRooms([])).then(() => undefined),
      this.now,
    );
  }

  private clientFor(pair: ApiKeyPair): RoomServiceClient {
    let client = this.clients.get(pair);
    if (!client) {
      client = new RoomServiceClient(httpOrigin(this.config.url), pair.key, pair.secret);
      this.clients.set(pair, client);
    }
    return client;
  }

  /** One REST call; a rejected key switches to the previous pair and retries once, no more. */
  private async api<T>(call: (client: RoomServiceClient) => Promise<T>): Promise<T> {
    const pair = this.ring.active;
    try {
      return await call(this.clientFor(pair));
    } catch (error) {
      if (!isUnauthorized(error) || !this.ring.rotate(pair)) throw error;
      this.deps.logger?.warn('room_api_key_rotated');
      return call(this.clientFor(this.ring.active));
    }
  }

  health(signal: AbortSignal) {
    return this.healthy.check(signal);
  }

  async ensureRoom(input: { name: string; maxParticipants: number; emptyTimeoutSeconds: number }) {
    if (!ROOM_NAME.test(input.name)) throw new RangeError('Invalid room name');
    // CreateRoom on a room that exists returns it, so this is idempotent on the server too.
    await this.api((client) =>
      client.createRoom({
        name: input.name,
        maxParticipants: input.maxParticipants,
        emptyTimeout: input.emptyTimeoutSeconds,
        departureTimeout: input.emptyTimeoutSeconds,
      }),
    );
  }

  async deleteRoom(name: string) {
    try {
      await this.api((client) => client.deleteRoom(name));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async removeParticipant(room: string, identity: string) {
    try {
      await this.api((client) => client.removeParticipant(room, identity));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  mintToken(input: Parameters<MediaRoomProvider['mintToken']>[0]) {
    return mintOperatorToken(this.ring.active, input, this.now());
  }

  async join(input: {
    room: string;
    identity: string;
    format: AudioFormat;
    signal: AbortSignal;
  }): Promise<RoomSeat> {
    const token = await mintSeatToken(this.ring.active, input);
    return connectSeat({
      url: wsOrigin(this.config.url),
      token,
      format: input.format,
      signal: input.signal,
      now: this.now,
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    });
  }
}
