import { createLogger } from '@winsendotai/ovo-plugin-kit';
import { turnShadowTelemetry } from '@winsendotai/ovo-distribution';
import { createWorkerHealthServer, workerHealth } from './worker-health.ts';
import { runWorkerLoop, type WorkerStatus } from './worker-loop.ts';

// The model turn detector's counters (shadow comparisons, model unavailable) on verbose health.
workerHealth.source('turnDetector', () => turnShadowTelemetry.snapshot());

const status: WorkerStatus = { state: 'starting', detail: 'initializing' };
const server = createWorkerHealthServer(Number(process.env.PORT ?? 4100), () => status, {
  token: process.env.OVO_HEALTH_TOKEN || undefined,
});

runWorkerLoop({ status, server }).catch((error: unknown) => {
  status.state = 'failed';
  status.detail = error instanceof Error ? error.message : String(error);
  createLogger({ service: 'worker' }).error('worker_startup_failed', { detail: status.detail });
  process.exitCode = 1;
});
