import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { startSipGateway } from '../../src/service.ts';
import { testConfig, recordingLogger } from '../support/harness.ts';
import { FakeMediaGateway } from '../support/fake-media-gateway.ts';
import { KEY } from '../support/harness.ts';

describe('startSipGateway failing to boot', () => {
  it('releases the UDP socket it already bound when the TCP port is taken', async () => {
    // Hold a TCP port, then ask the gateway for the same number: UDP binds, TCP fails.
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    const media = new FakeMediaGateway({ key: KEY });
    await media.start();
    try {
      const config = {
        ...testConfig({ mediaUrl: media.url, env: { OVO_SIP_PORT: String(port) } }),
        sipPort: port,
      };
      await expect(startSipGateway({ config, logger: recordingLogger() })).rejects.toThrow(
        /EADDRINUSE/,
      );
      // The UDP side must be free again: a leaked socket would make this bind fail.
      const probe = createSocket('udp4');
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.bind(port, '127.0.0.1', resolve);
      });
      probe.close();
    } finally {
      blocker.close();
      await media.stop();
    }
  });
});
