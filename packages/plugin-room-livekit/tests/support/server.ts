import { RoomServiceClient } from 'livekit-server-sdk';
import { availableLiveKit, type TestServer } from '../../src/testing.ts';
import { LiveKitRoomProvider } from '../../src/provider.ts';

/** A real server for the file, or undefined (the suite then skips, and says why on stderr). */
export async function serverOrSkip(file: string): Promise<TestServer | undefined> {
  const server = await availableLiveKit();
  if (!server)
    console.warn(
      `[${file}] skipped: no LiveKit server (set OVO_LIVEKIT_TEST_URL/_API_KEY/_API_SECRET or brew install livekit)`,
    );
  return server;
}

let counter = 0;
export const roomName = (prefix = 'ovo-hq-test') => `${prefix}-${process.pid}-${(counter += 1)}`;

export function admin(server: TestServer): RoomServiceClient {
  return new RoomServiceClient(server.url.replace(/^ws/, 'http'), server.apiKey, server.apiSecret);
}

export const providerFor = (server: TestServer, overrides = {}) =>
  new LiveKitRoomProvider(server.config(overrides));

export const idle = () => new AbortController().signal;
