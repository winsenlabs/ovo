// Workers 2..N of the load test, each its own process like a Compose worker container.
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { Sample } from './capacity.ts';

const HERE = new URL('.', import.meta.url).pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Workers 2..N as their own processes, with worker-1's Compose environment and their own identity. */
export async function startWorkers(count: number, warmFloor: number, samples: Sample[]) {
  const children: ChildProcess[] = [];
  for (let index = 2; index <= count + 1; index += 1) {
    const port = await freePort();
    const child = fork(`${HERE}worker-child.ts`, [], {
      execArgv: [
        '--import',
        'tsx',
        '--import',
        `${HERE}../register-sql.mjs`,
        '--import',
        `${HERE}register-routed-net.mjs`,
      ],
      env: {
        ...process.env,
        OVO_WORKER_ID: `load-worker-${index}`,
        PORT: String(port),
        OVO_WORKER_ENDPOINT: `ws://127.0.0.1:${port}/internal/media`,
        OVO_INBOUND_WARM_FLOOR: String(warmFloor),
        OVO_LOG_LEVEL: process.env.OVO_LOG_LEVEL ?? 'error',
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    child.on('message', (message: Record<string, unknown>) => {
      if (message.type !== 'stats') return;
      samples.push({
        process: `worker-${index}`,
        atMs: Date.now(),
        cpuPercent: Number(message.cpuPercent),
        rssBytes: Number(message.rssBytes),
        eventLoopP99Ms: Number(message.eventLoopP99Ms),
      });
    });
    children.push(child);
  }
  return {
    children,
    async stop() {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null) return;
          child.send('stop');
          const exited = once(child, 'exit');
          await Promise.race([exited, sleep(20_000).then(() => child.kill('SIGKILL'))]);
        }),
      );
    },
  };
}
