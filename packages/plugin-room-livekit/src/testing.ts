import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { RoomConfig } from './config.ts';

export const TEST_API_KEY = 'ovotestkey';
export const TEST_API_SECRET = 'ovo-test-secret-ovo-test-secret-0123456789';

export interface TestServer {
  /** Loopback signalling URL (ws://127.0.0.1:<port>). */
  url: string;
  apiKey: string;
  apiSecret: string;
  /** The plugin config that reaches this server. */
  config(overrides?: Partial<RoomConfig>): RoomConfig;
  stop(): Promise<void>;
}

/**
 * Free TCP/UDP ports, picked by a short-lived child process: a vendor plugin may not import
 * node:net, and a child that binds port 0 and prints what it got is the honest way to ask the OS.
 */
export function pickPorts(count: number): Promise<number[]> {
  const script = `
    const net = require('node:net');
    const servers = Array.from({ length: ${count} }, () => net.createServer());
    Promise.all(servers.map((s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))))
      .then((ports) => { console.log(JSON.stringify(ports)); servers.forEach((s) => s.close()); });`;
  return new Promise((resolve, reject) =>
    execFile(process.execPath, ['-e', script], (error, stdout) =>
      error ? reject(error) : resolve(JSON.parse(stdout) as number[]),
    ),
  );
}

/** `OVO_E2E_LIVEKIT_BIN`, else `livekit-server` on PATH (brew install livekit, Apache-2.0). */
export function findLiveKitBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = env.OVO_E2E_LIVEKIT_BIN
    ? [env.OVO_E2E_LIVEKIT_BIN]
    : (env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'livekit-server'));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // swallow-ok: not there or not executable; the next PATH entry may be.
    }
  }
  return undefined;
}

async function waitReady(port: number, child: ChildProcess, stderr: () => string): Promise<void> {
  let exited = false;
  child.once('exit', () => (exited = true));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (exited) throw new Error(`livekit-server exited early:\n${stderr()}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch {
      // swallow-ok: not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`livekit-server did not come up on :${port}:\n${stderr()}`);
}

/** A local server on loopback only, ephemeral ports, rooms created only through the API. */
export async function startLiveKitServer(
  options: { binary?: string; apiKey?: string; apiSecret?: string } = {},
): Promise<TestServer> {
  const binary = options.binary ?? findLiveKitBinary();
  if (!binary) throw new Error('livekit-server is not installed (brew install livekit)');
  const apiKey = options.apiKey ?? TEST_API_KEY;
  const apiSecret = options.apiSecret ?? TEST_API_SECRET;
  const [http, tcp, udp] = await pickPorts(3);
  const dir = mkdtempSync(join(tmpdir(), 'ovo-livekit-'));
  writeFileSync(
    join(dir, 'livekit.yaml'),
    [
      `port: ${http}`,
      'bind_addresses:',
      '  - 127.0.0.1',
      'rtc:',
      `  tcp_port: ${tcp}`,
      `  udp_port: ${udp}`,
      '  use_external_ip: false',
      '  node_ip: 127.0.0.1',
      'keys:',
      `  ${apiKey}: ${apiSecret}`,
      'room:',
      '  auto_create: false',
      'logging:',
      '  level: warn',
      '',
    ].join('\n'),
  );
  const child = spawn(binary, ['--config', join(dir, 'livekit.yaml')], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
  const kill = () => child.kill('SIGKILL');
  process.once('exit', kill);
  try {
    await waitReady(http!, child, () => stderr);
  } catch (error) {
    kill();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const url = `ws://127.0.0.1:${http}`;
  return {
    url,
    apiKey,
    apiSecret,
    config: (overrides = {}) => ({ url, publicUrl: url, apiKey, apiSecret, ...overrides }),
    async stop() {
      process.off('exit', kill);
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
        kill();
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A server for tests, or undefined (the test then skips with its reason): one the environment
 * names (`OVO_LIVEKIT_TEST_URL` + `_API_KEY` + `_API_SECRET`, e.g. from the e2e ensure script), else
 * a local binary started on loopback.
 */
export async function availableLiveKit(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestServer | undefined> {
  const {
    OVO_LIVEKIT_TEST_URL: url,
    OVO_LIVEKIT_TEST_API_KEY: key,
    OVO_LIVEKIT_TEST_API_SECRET: secret,
  } = env;
  if (url && key && secret)
    return {
      url,
      apiKey: key,
      apiSecret: secret,
      config: (overrides = {}) => ({
        url,
        publicUrl: url,
        apiKey: key,
        apiSecret: secret,
        ...overrides,
      }),
      stop: async () => undefined,
    };
  return findLiveKitBinary(env) ? startLiveKitServer() : undefined;
}
