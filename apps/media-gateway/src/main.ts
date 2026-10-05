import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import { startGateway } from './startup.ts';

const logger = createLogger({ service: 'media-gateway' });

async function main(): Promise<void> {
  const runtime = await startGateway();
  logger.info('gateway_ready');
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('gateway_draining', { signal });
    await runtime.close();
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

void main().catch((error) => {
  logger.error('gateway_startup_failed', errorFields(error));
  process.exitCode = 1;
});
