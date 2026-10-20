import { AccessToken, TokenVerifier, TrackSource, type VideoGrant } from 'livekit-server-sdk';

/** A browser join token never lives longer than this, whatever the caller asks. */
export const TOKEN_TTL_MAX_SECONDS = 600;
/** The server-side seat connects at once; its token is minted in-process and never leaves it. */
const SEAT_TTL_SECONDS = 60;

export interface ApiKeyPair {
  key: string;
  secret: string;
}

/**
 * The current key pair and, during a rotation, the previous one. Calls use `active`; when the
 * server rejects it (the operator rotated one side first) `rotate()` switches to the other.
 */
export class KeyRing {
  private index = 0;
  private readonly pairs: readonly ApiKeyPair[];

  constructor(current: ApiKeyPair, previous?: ApiKeyPair) {
    this.pairs = previous ? [current, previous] : [current];
  }

  get active(): ApiKeyPair {
    return this.pairs[this.index]!;
  }

  /**
   * After `tried` was rejected: true when another pair is now (or already was) active, so the call
   * should retry with it; false when there is none. A second call that failed on the same pair
   * while the first was switching finds the switch done and does not switch back.
   */
  rotate(tried: ApiKeyPair): boolean {
    if (this.pairs.length < 2) return false;
    if (tried === this.active) this.index = (this.index + 1) % this.pairs.length;
    return true;
  }
}

export type TokenRole = 'operator' | 'monitor';
const IDENTITY: Record<TokenRole, RegExp> = {
  operator: /^op:[A-Za-z0-9._@-]{1,120}$/,
  monitor: /^mon:[A-Za-z0-9._@-]{1,120}$/,
};
export const ROOM_NAME = /^[A-Za-z0-9._-]{1,128}$/;
/** The server-side seat: no `op:`/`mon:` prefix (and no colon at all), so it can never pass as one. */
export const SEAT_IDENTITY = /^[A-Za-z0-9._-]{1,64}$/;

export interface MintInput {
  room: string;
  identity: string;
  name: string;
  role: TokenRole;
  ttlSeconds: number;
}

/**
 * The operator's grant, exactly: one room, microphone audio and nothing else to publish, audio
 * subscribe, no data publish, no admin, list, create or record. A monitor only listens.
 */
export function operatorGrant(room: string, role: TokenRole): VideoGrant {
  return {
    room,
    roomJoin: true,
    canPublish: role === 'operator',
    canPublishSources: role === 'operator' ? [TrackSource.MICROPHONE] : [],
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    hidden: false,
    recorder: false,
    roomAdmin: false,
    roomList: false,
    roomCreate: false,
    roomRecord: false,
    ingressAdmin: false,
  };
}

function check(input: MintInput): void {
  if (!ROOM_NAME.test(input.room)) throw new RangeError('Invalid room name');
  if (!IDENTITY[input.role].test(input.identity))
    throw new RangeError(
      `A ${input.role} identity must look like ${input.role === 'operator' ? 'op' : 'mon'}:<id>`,
    );
  if (
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds < 1 ||
    input.ttlSeconds > TOKEN_TTL_MAX_SECONDS
  )
    throw new RangeError(`ttlSeconds must be an integer from 1 to ${TOKEN_TTL_MAX_SECONDS}`);
}

/** A short-TTL, room-scoped join token for the browser. */
export async function mintOperatorToken(
  pair: ApiKeyPair,
  input: MintInput,
  now: number,
): Promise<{ token: string; expiresAt: string }> {
  check(input);
  // Display names are shown to the caller-side logs only; strip anything that is not text.
  const name = input.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) || input.identity;
  const token = new AccessToken(pair.key, pair.secret, {
    identity: input.identity,
    name,
    ttl: input.ttlSeconds,
  });
  token.addGrant(operatorGrant(input.room, input.role));
  return {
    token: await token.toJwt(),
    expiresAt: new Date(now + input.ttlSeconds * 1000).toISOString(),
  };
}

/** The caller's seat token: audio both ways plus data for captions, valid for one connect. */
export async function mintSeatToken(
  pair: ApiKeyPair,
  input: { room: string; identity: string },
): Promise<string> {
  if (!ROOM_NAME.test(input.room)) throw new RangeError('Invalid room name');
  if (!SEAT_IDENTITY.test(input.identity)) throw new RangeError('Invalid seat identity');
  const token = new AccessToken(pair.key, pair.secret, {
    identity: input.identity,
    ttl: SEAT_TTL_SECONDS,
  });
  token.addGrant({
    room: input.room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
    roomAdmin: false,
    roomList: false,
    roomCreate: false,
  });
  return token.toJwt();
}

/** Decodes and verifies a token the way the server does; tests use it to pin the claims. */
export function verifyToken(pair: ApiKeyPair, token: string) {
  return new TokenVerifier(pair.key, pair.secret).verify(token);
}
