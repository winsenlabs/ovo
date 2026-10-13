import type { Server } from 'node:http';
import { createControlServer } from './control/server.ts';
import { SipGateway, type GatewayOptions } from './gateway.ts';
import { createHealthServer } from './health.ts';

export interface RunningGateway {
  gateway: SipGateway;
  /** The bound control and health ports (they differ from the config when it asked for 0). */
  ports: { sip: number; control: number; health: number };
  /** SIGTERM: drain the calls, then close every socket. */
  stop(): Promise<void>;
  /** Closes everything now; live calls end without a BYE (tests, failed boots). */
  close(): Promise<void>;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Boots the sip-gateway: SIP and RTP sockets, then the control API, then health (§4.1). */
export async function startSipGateway(options: GatewayOptions): Promise<RunningGateway> {
  const gateway = new SipGateway(options);
  await gateway.start();
  const control = createControlServer(gateway);
  const health = createHealthServer(gateway);
  const { config } = options;
  let ports;
  try {
    ports = {
      sip: gateway.endpoint.port,
      control: await listen(control, config.control.host, config.control.port),
      health: await listen(health, config.health.host, config.health.port),
    };
  } catch (error) {
    await Promise.all([close(control), close(health), gateway.close()]);
    throw error;
  }
  gateway.logger.info('sip.ready', {
    bind: config.bindHost,
    public: config.public,
    transports: config.transports,
    trunks: config.trunks.length,
    ...ports,
  });
  let stopping: Promise<void> | undefined;
  const shutdown = () =>
    Promise.all([close(control), close(health), gateway.close()]).then(() => undefined);
  return {
    gateway,
    ports,
    stop() {
      stopping ??= (async () => {
        await gateway.drain();
        // Let the BYEs of the drained calls leave before the sockets close.
        await gateway.sleep(1_000);
        await shutdown();
      })();
      return stopping;
    },
    close() {
      stopping ??= shutdown();
      return stopping;
    },
  };
}
