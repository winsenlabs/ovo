import { startGateway } from './startup.ts';

async function main(): Promise<void> {
  const runtime = await startGateway();
  console.log(JSON.stringify({ service: 'media-gateway', ready: true }));
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ service: 'media-gateway', draining: true, signal }));
    await runtime.close();
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
