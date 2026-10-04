import { expect, it, vi } from 'vitest';
import { withEgressSentinel } from '@winsendotai/ovo-conformance/drivers';
vi.mock('@livekit/rtc-node', () => {
  throw new Error('native bindings loaded eagerly');
});
vi.mock('@livekit/agents', () => {
  throw new Error('LiveKit loaded eagerly');
});
it('publishes the production engine and speech companion without loading LiveKit or native bindings', async () => {
  await withEgressSentinel(
    async (sentinel) => {
      const { plugins } = await import('../src/index.ts');
      expect(plugins.map((plugin) => plugin.manifest.id)).toEqual([
        '@winsendotai/ovo-engine-livekit',
        '@winsendotai/ovo-engine-livekit/speech',
      ]);
      expect(sentinel.attempts).toEqual([]);
    },
    { allowLoopback: false },
  );
});
