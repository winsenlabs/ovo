// One worker process of the load test, as one Compose worker container runs: it serves one call
// at a time and reports its CPU, memory and event-loop delay to the parent every half second.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createWorkerHealthServer } from '../../apps/worker/src/worker-health.ts';
import { runWorkerLoop, type WorkerStatus } from '../../apps/worker/src/worker-loop.ts';

const status: WorkerStatus = { state: 'starting', detail: 'initializing' };
const server = createWorkerHealthServer(Number(process.env.PORT), () => status);
let stop = () => undefined as void;
const loop = runWorkerLoop({
  status,
  server,
  registerShutdown: (callback) => (stop = callback),
}).catch((error: unknown) => {
  status.state = 'failed';
  status.detail = error instanceof Error ? error.message : String(error);
});

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let cpu = process.cpuUsage();
let at = performance.now();
setInterval(() => {
  const used = process.cpuUsage(cpu);
  const now = performance.now();
  process.send?.({
    type: 'stats',
    state: status.state,
    detail: status.state === 'failed' ? status.detail : undefined,
    cpuPercent: ((used.user + used.system) / 1000 / (now - at)) * 100,
    rssBytes: process.memoryUsage().rss,
    eventLoopP99Ms: delay.percentile(99) / 1e6,
  });
  cpu = process.cpuUsage();
  at = now;
  delay.reset();
}, 500).unref();

process.on('message', (message) => {
  if (message !== 'stop') return;
  stop();
  void loop.then(() => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
});
