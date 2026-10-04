import { createServer } from 'node:http';

export interface WorkerStatus {
  state: 'starting' | 'dial-disabled' | 'ready' | 'reserved' | 'active' | 'draining' | 'failed';
  detail: string;
}

export function createWorkerHealthServer(port: number, snapshot: () => WorkerStatus) {
  const server = createServer((request, response) => {
    if (request.url !== '/health' && request.url !== '/ready') {
      response.writeHead(404).end();
      return;
    }
    const current = snapshot();
    const healthy = current.state !== 'failed';
    const ready = current.state === 'ready' || current.state === 'dial-disabled';
    response.writeHead(request.url === '/ready' && !ready ? 503 : healthy ? 200 : 503, {
      'content-type': 'application/json',
    });
    response.end(
      JSON.stringify({
        ...current,
        liveDialEnabled: process.env.OVO_LIVE_DIAL_ENABLED === 'true',
      }),
    );
  });
  server.listen(port, '0.0.0.0');
  return server;
}

export function watchWorkerShutdown(
  input: { registerShutdown?: (callback: () => void) => void },
  shutdown: () => Promise<void>,
): void {
  if (input.registerShutdown) input.registerShutdown(() => void shutdown());
  else {
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
  }
}
