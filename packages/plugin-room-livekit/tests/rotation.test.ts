import { afterAll, describe, expect, it } from 'vitest';
import { LiveKitRoomProvider } from '../src/provider.ts';
import { verifyToken } from '../src/tokens.ts';
import { admin, roomName, serverOrSkip } from './support/server.ts';

const server = await serverOrSkip('rotation.test.ts');
afterAll(() => server?.stop());

const WRONG = { apiKey: 'rotated-away', apiSecret: 'a-secret-the-server-never-knew-0123456789' };

describe.skipIf(!server)('dual API keys during a rotation', () => {
  it('falls back to the previous pair when the server rejects the current one, then sticks with it', async () => {
    const warnings: string[] = [];
    const provider = new LiveKitRoomProvider(
      server!.config({
        ...WRONG,
        previousApiKey: server!.apiKey,
        previousApiSecret: server!.apiSecret,
      }),
      { logger: { warn: (event) => void warnings.push(event) } },
    );
    const name = roomName();
    await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
    expect((await admin(server!).listRooms()).some((room) => room.name === name)).toBe(true);
    // The next call goes straight to the pair that works: no second rotation.
    await provider.deleteRoom(name);
    expect(warnings).toEqual(['room_api_key_rotated']);
    // Tokens are now signed with that pair, so the server accepts them.
    const { token } = await provider.mintToken({
      room: name,
      identity: 'op:u1',
      name: 'U',
      role: 'operator',
      ttlSeconds: 60,
    });
    expect((await verifyToken({ key: server!.apiKey, secret: server!.apiSecret }, token)).iss).toBe(
      server!.apiKey,
    );
  });

  it('uses the current pair when it works and never touches the previous one', async () => {
    const provider = new LiveKitRoomProvider(
      server!.config({ previousApiKey: WRONG.apiKey, previousApiSecret: WRONG.apiSecret }),
    );
    const name = roomName();
    await provider.ensureRoom({ name, maxParticipants: 3, emptyTimeoutSeconds: 30 });
    await provider.deleteRoom(name);
    const { token } = await provider.mintToken({
      room: name,
      identity: 'op:u1',
      name: 'U',
      role: 'operator',
      ttlSeconds: 60,
    });
    expect((await verifyToken({ key: server!.apiKey, secret: server!.apiSecret }, token)).iss).toBe(
      server!.apiKey,
    );
  });

  it('fails with the server error when both pairs are rejected', async () => {
    const provider = new LiveKitRoomProvider(
      server!.config({ ...WRONG, previousApiKey: 'also-wrong', previousApiSecret: 'b'.repeat(40) }),
    );
    await expect(
      provider.ensureRoom({ name: roomName(), maxParticipants: 3, emptyTimeoutSeconds: 30 }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('does not retry on a non-auth failure', async () => {
    const warnings: string[] = [];
    const provider = new LiveKitRoomProvider(
      server!.config({ previousApiKey: WRONG.apiKey, previousApiSecret: WRONG.apiSecret }),
      { logger: { warn: (event) => void warnings.push(event) } },
    );
    // Deleting a missing room is a 404 the provider treats as done: no rotation, no throw.
    await provider.deleteRoom(roomName('missing'));
    expect(warnings).toEqual([]);
  });
});
