import { createServer } from 'node:http';

type WorkerState = 'starting' | 'dial-disabled' | 'ready' | 'active' | 'draining' | 'failed';

export function createWorkerHealthServer(
  port: number,
  snapshot: () => { state: WorkerState; detail: string },
) {
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
