import { createServer, type Server } from 'node:http';
import { openDispatcherProcess } from './dispatcher-process.ts';

type Environment = Record<string, string | undefined>;

export async function startDispatcher(input: {
  env: Environment;
  host?: string;
  port?: number;
  readProvisionedTasks?: () => Promise<number>;
  log?: (entry: Record<string, unknown>) => void;
}): Promise<{
  server: Server;
  loop: Awaited<ReturnType<typeof openDispatcherProcess>>['loop'];
  composition: Awaited<ReturnType<typeof openDispatcherProcess>>['composition'];
  close(): Promise<void>;
}> {
  const runtime = await openDispatcherProcess(input);
  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    const status = runtime.loop.health();
    response.writeHead(status.healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify(status));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(input.port ?? Number(input.env.PORT ?? 4002), input.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  runtime.loop.start();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      process.off('SIGTERM', onTerminate);
      process.off('SIGINT', onTerminate);
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })());
  const onTerminate = () => {
    void close();
  };
  process.once('SIGTERM', onTerminate);
  process.once('SIGINT', onTerminate);
  return { server, loop: runtime.loop, composition: runtime.composition, close };
}

// The bundled CJS file and the local tsx script both execute this module directly.
if (process.argv[1] && /(?:^|\/)main\.(?:cjs|ts)$/.test(process.argv[1])) {
  void startDispatcher({
    env: process.env,
    log: (entry) => console.error(JSON.stringify(entry)),
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
