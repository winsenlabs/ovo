import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

export class EgressBlockedError extends Error {
  constructor(readonly target: string) {
    super(`Egress blocked by the conformance sentinel: ${target}`);
    this.name = 'EgressBlockedError';
  }
}

export interface EgressSentinel {
  /** Every blocked attempt, in order. */
  readonly attempts: readonly string[];
  restore(): void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function describeTarget(args: unknown[]): { host: string; text: string } {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: string; port?: number; path?: string };
    if (options.path) return { host: 'ipc', text: `ipc ${options.path}` };
    const host = options.host ?? 'localhost';
    return { host, text: `${host}:${options.port ?? '?'}` };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first))
    return { host: 'ipc', text: `ipc ${first}` };
  const host = typeof second === 'string' ? second : 'localhost';
  return { host, text: `${host}:${String(first)}` };
}

/**
 * Stubs `net.connect`, `net.createConnection`, `tls.connect`, `fetch` and `WebSocket` to throw,
 * and deletes every `LIVEKIT_*` variable, until `restore()`. With `allowLoopback`, 127.0.0.1,
 * ::1 and localhost sockets (and IPC paths) still connect, for loopback fixture servers.
 */
export function installEgressSentinel(options: { allowLoopback?: boolean } = {}): EgressSentinel {
  const attempts: string[] = [];
  const original = {
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    tlsConnect: tls.connect,
    fetch: globalThis.fetch,
    WebSocket: (globalThis as { WebSocket?: unknown }).WebSocket,
  };
  const removedEnv: [string, string][] = [];
  for (const [key, value] of Object.entries(process.env))
    if (key.startsWith('LIVEKIT_') && value !== undefined) {
      removedEnv.push([key, value]);
      delete process.env[key];
    }

  const guard = <T extends (...args: never[]) => unknown>(real: T, kind: string): T =>
    ((...args: never[]) => {
      const target = describeTarget(args);
      if ((options.allowLoopback && LOOPBACK.has(target.host)) || target.host === 'ipc')
        return real(...args);
      attempts.push(`${kind} ${target.text}`);
      throw new EgressBlockedError(`${kind} ${target.text}`);
    }) as T;

  net.connect = guard(original.netConnect, 'net.connect');
  net.createConnection = guard(original.netCreateConnection, 'net.createConnection');
  tls.connect = guard(original.tlsConnect, 'tls.connect');
  syncBuiltinESMExports();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (options.allowLoopback && LOOPBACK.has(host)) return original.fetch(input);
    attempts.push(`fetch ${url}`);
    throw new EgressBlockedError(`fetch ${url}`);
  }) as typeof globalThis.fetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = class BlockedWebSocket {
    constructor(url: string | URL) {
      attempts.push(`WebSocket ${String(url)}`);
      throw new EgressBlockedError(`WebSocket ${String(url)}`);
    }
  };

  let restored = false;
  return {
    attempts,
    restore() {
      if (restored) return;
      restored = true;
      net.connect = original.netConnect;
      net.createConnection = original.netCreateConnection;
      tls.connect = original.tlsConnect;
      syncBuiltinESMExports();
      globalThis.fetch = original.fetch;
      (globalThis as { WebSocket?: unknown }).WebSocket = original.WebSocket;
      for (const [key, value] of removedEnv) process.env[key] = value;
    },
  };
}

/** Runs `fn` under the sentinel and always restores it. */
export async function withEgressSentinel<T>(
  fn: (sentinel: EgressSentinel) => Promise<T> | T,
  options: { allowLoopback?: boolean } = {},
): Promise<T> {
  const sentinel = installEgressSentinel(options);
  try {
    return await fn(sentinel);
  } finally {
    sentinel.restore();
  }
}
