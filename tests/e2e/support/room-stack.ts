import {
  findLiveKitBinary,
  startLiveKitServer,
  type TestServer,
} from '../../../packages/plugin-room-livekit/src/testing.ts';
import { humanStack, type HumanStackOptions } from './human-setup.ts';

/** The room server binary these scenarios need, or undefined (the files then skip, saying why). */
export const roomServerBinary = () => findLiveKitBinary(process.env.OVO_E2E_LIVEKIT_BIN);

/**
 * A real LiveKit server on loopback and an installation wired to it, with a managed queue on the
 * line (digit 3). Close it before the next one starts: each holds database connections.
 */
export async function startRoomStack(
  postgresUrl: string,
  routes: Map<string, string>,
  options: Omit<HumanStackOptions, 'room'> = {},
) {
  const binary = roomServerBinary();
  if (!binary) throw new Error('livekit-server is not installed (brew install livekit)');
  const server: TestServer = await startLiveKitServer({ binary });
  try {
    const env = await humanStack(postgresUrl, routes, {
      ...options,
      room: server,
      line: { managed: true, external: false, ...options.line },
    });
    return {
      server,
      env,
      async close() {
        await env.close();
        await server.stop();
      },
    };
  } catch (error) {
    await server.stop();
    throw error;
  }
}
export type RoomStack = Awaited<ReturnType<typeof startRoomStack>>;
