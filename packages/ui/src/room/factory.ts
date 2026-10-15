import type { RoomClient } from './client.ts';
import { createFakeRoomClient } from './fake.ts';

export class UnsupportedRoomProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`No browser adapter is registered for room provider "${provider}".`);
  }
}

type Loader = () => Promise<RoomClient>;

/**
 * Adapters by provider id, each behind a dynamic `import()` so a screen that never joins a room
 * (every one but the desk) ships none of it. `fake` is the deterministic client the Vitest and
 * Playwright fixtures select through `GET /v1/desk/me`.
 */
const loaders = new Map<string, Loader>([
  ['fake', async () => createFakeRoomClient()],
  [
    'livekit',
    async () => {
      const [{ createBrowserRoomClient }, sdk] = await Promise.all([
        import('./adapter-browser.ts'),
        import('livekit-client'),
      ]);
      return createBrowserRoomClient(sdk);
    },
  ],
]);

/** The client for the provider the API reports; rejects for a provider this build has no adapter for. */
export async function createRoomClient(provider: string): Promise<RoomClient> {
  const load = loaders.get(provider);
  if (!load) throw new UnsupportedRoomProviderError(provider);
  return load();
}

/** Registers or replaces an adapter (tests, or a second room server later); returns an undo. */
export function registerRoomAdapter(provider: string, load: Loader): () => void {
  const previous = loaders.get(provider);
  loaders.set(provider, load);
  return () => {
    if (previous) loaders.set(provider, previous);
    else loaders.delete(provider);
  };
}
