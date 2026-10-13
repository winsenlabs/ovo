import { errorFields } from '@winsendotai/ovo-plugin-kit';
import { loadConfig } from './config/env.ts';
import { rootLogger } from './log.ts';
import { startSipGateway } from './service.ts';

async function main(): Promise<void> {
  // Fails closed: a missing secret, token or trunk file stops the boot here.
  const config = loadConfig(process.env);
  const running = await startSipGateway({ config });
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    rootLogger.info('sip.drain_started', { signal, calls: running.gateway.registry.size });
    await running.stop();
    rootLogger.info('sip.stopped', { signal });
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

void main().catch((error) => {
  rootLogger.error('sip.startup_failed', errorFields(error));
  process.exitCode = 1;
});
