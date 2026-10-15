import { describe, expect, it } from 'vitest';
import {
  KeyRing,
  TOKEN_TTL_MAX_SECONDS,
  mintOperatorToken,
  mintSeatToken,
  operatorGrant,
  verifyToken,
} from '../src/tokens.ts';

const PAIR = { key: 'k-current', secret: 'secret-current-secret-current-0123456789' };
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const input = {
  room: 'ovo-hq-7f3a',
  identity: 'op:user-1',
  name: 'Asha K',
  role: 'operator' as const,
  ttlSeconds: 120,
};

describe('operator join token claims (verified with the real server SDK)', () => {
  it('grants exactly one room, microphone audio and audio subscribe, and nothing else', async () => {
    const { token } = await mintOperatorToken(PAIR, input, NOW);
    const claims = await verifyToken(PAIR, token);
    expect(claims.sub).toBe('op:user-1');
    expect(claims.iss).toBe('k-current');
    expect(claims.name).toBe('Asha K');
    expect(claims.video).toEqual({
      room: 'ovo-hq-7f3a',
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
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
    });
    expect(claims.sip).toBeUndefined();
  });

  it('expires after the TTL and reports when', async () => {
    const { token, expiresAt } = await mintOperatorToken(PAIR, input, NOW);
    const claims = await verifyToken(PAIR, token);
    expect(claims.exp! - claims.nbf!).toBe(120);
    expect(expiresAt).toBe('2026-10-15T12:02:00.000Z');
  });

  it.each([1, 120, TOKEN_TTL_MAX_SECONDS])('accepts a TTL of %i seconds', async (ttlSeconds) => {
    const { token } = await mintOperatorToken(PAIR, { ...input, ttlSeconds }, NOW);
    const claims = await verifyToken(PAIR, token);
    expect(claims.exp! - claims.nbf!).toBe(ttlSeconds);
  });

  it.each([0, -5, 601, 3600, 1.5, Number.NaN, Infinity])(
    'refuses a TTL of %s',
    async (ttlSeconds) => {
      await expect(mintOperatorToken(PAIR, { ...input, ttlSeconds }, NOW)).rejects.toThrow(
        /ttlSeconds/,
      );
    },
  );

  it('is signed by the key it was given: another secret does not verify', async () => {
    const { token } = await mintOperatorToken(PAIR, input, NOW);
    await expect(verifyToken({ ...PAIR, secret: 'x'.repeat(40) }, token)).rejects.toThrow();
  });

  it.each([
    ['no prefix', 'user-1'],
    ['the caller seat name', 'caller'],
    ['a monitor prefix on an operator', 'mon:user-1'],
    ['an empty id', 'op:'],
    ['a space', 'op:user 1'],
    ['an uppercase prefix', 'OP:user-1'],
    ['a second colon', 'op:a:b'],
    ['a newline', 'op:a\nb'],
  ])('refuses an operator identity with %s', async (_what, identity) => {
    await expect(mintOperatorToken(PAIR, { ...input, identity }, NOW)).rejects.toThrow(/identity/);
  });

  it.each(['', 'a b', '../x', 'room/1', 'x'.repeat(129), 'r\n'])(
    'refuses the room name %j',
    async (room) => {
      await expect(mintOperatorToken(PAIR, { ...input, room }, NOW)).rejects.toThrow(/room name/);
    },
  );

  it('strips control characters from the display name and falls back to the identity', async () => {
    const dirty = await verifyToken(
      PAIR,
      (await mintOperatorToken(PAIR, { ...input, name: 'A\u0000s\u001fha\n' }, NOW)).token,
    );
    expect(dirty.name).toBe('Asha');
    const empty = await verifyToken(
      PAIR,
      (await mintOperatorToken(PAIR, { ...input, name: '\u0000' }, NOW)).token,
    );
    expect(empty.name).toBe('op:user-1');
  });

  it('a monitor only listens', async () => {
    const { token } = await mintOperatorToken(
      PAIR,
      { ...input, identity: 'mon:sup-1', role: 'monitor' },
      NOW,
    );
    const claims = await verifyToken(PAIR, token);
    expect(claims.video).toMatchObject({
      canPublish: false,
      canPublishSources: [],
      canSubscribe: true,
      canPublishData: false,
      roomAdmin: false,
    });
    await expect(
      mintOperatorToken(PAIR, { ...input, identity: 'op:sup-1', role: 'monitor' }, NOW),
    ).rejects.toThrow(/identity/);
  });

  it('operatorGrant never sets an admin, list, create, record or ingress right', () => {
    for (const role of ['operator', 'monitor'] as const) {
      const grant = operatorGrant('r', role);
      for (const right of [
        'roomAdmin',
        'roomList',
        'roomCreate',
        'roomRecord',
        'ingressAdmin',
        'recorder',
        'hidden',
      ] as const)
        expect(grant[right]).toBe(false);
    }
  });
});

describe('seat token (minted in-process)', () => {
  it('lets the caller seat publish audio and data in one room for about a minute', async () => {
    const token = await mintSeatToken(PAIR, { room: 'ovo-hq-7f3a', identity: 'caller' });
    const claims = await verifyToken(PAIR, token);
    expect(claims.sub).toBe('caller');
    expect(claims.exp! - claims.nbf!).toBe(60);
    expect(claims.video).toMatchObject({
      room: 'ovo-hq-7f3a',
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: false,
      roomList: false,
      roomCreate: false,
    });
  });

  it.each(['op:x', 'mon:x', 'a:b', '', 'a b', 'x'.repeat(65)])(
    'refuses the seat identity %j, so a seat can never pass as an operator',
    async (identity) => {
      await expect(mintSeatToken(PAIR, { room: 'r', identity })).rejects.toThrow(/identity/);
    },
  );
});

describe('KeyRing', () => {
  const previous = { key: 'k-previous', secret: 'secret-previous-secret-previous-0123456' };

  it('uses the current pair and switches to the previous once it is rejected', () => {
    const ring = new KeyRing(PAIR, previous);
    expect(ring.active).toBe(PAIR);
    expect(ring.rotate(PAIR)).toBe(true);
    expect(ring.active).toBe(previous);
  });

  it('a racing second failure on the same pair retries with the new one and does not switch back', () => {
    const ring = new KeyRing(PAIR, previous);
    expect(ring.rotate(PAIR)).toBe(true);
    expect(ring.rotate(PAIR)).toBe(true);
    expect(ring.active).toBe(previous);
  });

  it('has nowhere to go without a previous pair', () => {
    const ring = new KeyRing(PAIR);
    expect(ring.rotate(PAIR)).toBe(false);
    expect(ring.active).toBe(PAIR);
  });
});
