import { createWorkerHealthServer } from './worker-health.ts';
import { runWorkerLoop, type WorkerStatus } from './worker-loop.ts';

const status: WorkerStatus = { state: 'starting', detail: 'initializing' };
const server = createWorkerHealthServer(Number(process.env.PORT ?? 4100), () => status);

runWorkerLoop({ status, server }).catch((error: unknown) => {
  status.state = 'failed';
  status.detail = error instanceof Error ? error.message : String(error);
  console.error('worker startup failed:', status.detail);
  process.exitCode = 1;
});
