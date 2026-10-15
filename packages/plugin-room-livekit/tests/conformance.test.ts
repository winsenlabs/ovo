import { describeMediaRoom, fakeMediaRoom } from '@winsendotai/ovo-conformance';
import { PCM16_16K } from '@winsendotai/ovo-contracts';
import { afterAll, it } from 'vitest';
import { livekitUnderTest } from './support/livekit-client.ts';
import { serverOrSkip } from './support/server.ts';

// media-room@1 over the reference fake, always, and over the real plugin against a real LiveKit
// server when one is available (OVO_LIVEKIT_TEST_URL/_API_KEY/_API_SECRET, or livekit-server on
// PATH); the real plugin also runs it for a wideband seat, since the format is the lease's.
describeMediaRoom('fakeMediaRoom (reference)', () => fakeMediaRoom());

const server = await serverOrSkip('conformance.test.ts');
afterAll(() => server?.stop());

if (server) {
  describeMediaRoom('LiveKit room plugin, mu-law 8 kHz (real server)', () =>
    livekitUnderTest(server),
  );
  describeMediaRoom(
    'LiveKit room plugin, PCM16 16 kHz (real server)',
    () => livekitUnderTest(server),
    {
      format: PCM16_16K,
    },
  );
} else it.skip('LiveKit room plugin conformance: no LiveKit server available', () => undefined);
