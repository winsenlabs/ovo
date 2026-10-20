import { describe, expect, it } from 'vitest';
import { parseRoomConfig } from '../src/config.ts';
import { LiveKitRoomProvider } from '../src/provider.ts';
import { verifyToken } from '../src/tokens.ts';

const base = {
  url: 'ws://127.0.0.1:7880',
  apiKey: 'k',
  apiSecret: 'a-secret-that-is-long-enough-0123456789',
};
const mint = (provider: LiveKitRoomProvider, ttlSeconds: number) =>
  provider.mintToken({ room: 'r', identity: 'op:u1', name: 'U', role: 'operator', ttlSeconds });

describe('the operator token ceiling from the config', () => {
  it('caps a token at tokenTtlSeconds, and at 600 when none is configured', async () => {
    const capped = new LiveKitRoomProvider(parseRoomConfig({ ...base, tokenTtlSeconds: 120 }));
    expect((await mint(capped, 120)).token).toBeTruthy();
    await expect(mint(capped, 121)).rejects.toThrow(/capped at 120/);
    const open = new LiveKitRoomProvider(parseRoomConfig(base));
    const claims = await verifyToken(
      { key: 'k', secret: base.apiSecret },
      (await mint(open, 600)).token,
    );
    expect(claims.exp! - claims.nbf!).toBe(600);
    await expect(mint(open, 601)).rejects.toThrow();
  });
});
