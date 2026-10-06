import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { timeoutOf } from '@winsendotai/ovo-contracts';

export interface WorkerStatus {
  state: 'starting' | 'dial-disabled' | 'ready' | 'reserved' | 'active' | 'draining' | 'failed';
  detail: string;
}

/** One provider origin as the last pre-warm saw it (LAT-8), named by the release slots using it. */
export interface ProviderReachability {
  origin: string;
  slots?: readonly string[];
  ok: boolean;
  status?: number;
  elapsedMs: number;
  error?: string;
}

const HANDSHAKE_SAMPLES = 200;
const MAX_REASONS = 50;

/**
 * The live-path state a worker keeps for `/health?verbose=1` and its slot report (OBS-12): the last
 * session-open failure, media handshake p50/p95, provider reachability from the cached pre-warm
 * results, how sessions ended (timeouts by stage), and any registered source such as the call-event
 * writer's counters.
 */
export class WorkerHealthState {
  private lastOpenFailure?: { stage: string; reason: string; sessionId?: string; at: string };
  private readonly handshakes: number[] = [];
  private readonly providers = new Map<string, ProviderReachability & { at: number }>();
  private readonly endReasons = new Map<string, number>();
  private readonly timeouts = new Map<string, number>();
  private readonly sources = new Map<string, () => unknown>();

  sessionOpenFailed(input: { stage: string; reason: string; sessionId?: string }): void {
    this.lastOpenFailure = { ...input, reason: input.reason.slice(0, 300), at: iso(Date.now()) };
  }

  handshake(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.handshakes.push(ms);
    if (this.handshakes.length > HANDSHAKE_SAMPLES) this.handshakes.shift();
  }

  prewarm(results: readonly ProviderReachability[], now = Date.now()): void {
    for (const result of results) this.providers.set(result.origin, { ...result, at: now });
  }

  sessionEnded(reason: string): void {
    const timeout = timeoutOf(reason);
    if (timeout) {
      const key = timeout.provider ? `${timeout.stage}:${timeout.provider}` : timeout.stage;
      this.timeouts.set(key, (this.timeouts.get(key) ?? 0) + 1);
    }
    // Reasons carry free text after `error:`; only the code before the first space is counted.
    const code = reason.split(/[\s:]/, 2).join(':').slice(0, 100);
    if (this.endReasons.has(code) || this.endReasons.size < MAX_REASONS)
      this.endReasons.set(code, (this.endReasons.get(code) ?? 0) + 1);
  }

  /** A named source read on every verbose snapshot; one that throws reports its error instead. */
  source(name: string, read: () => unknown): void {
    this.sources.set(name, read);
  }

  snapshot(now = Date.now()) {
    const sorted = [...this.handshakes].sort((left, right) => left - right);
    const sources: Record<string, unknown> = {};
    for (const [name, read] of this.sources)
      try {
        sources[name] = read();
      } catch (error) {
        sources[name] = { error: error instanceof Error ? error.message : String(error) };
      }
    return {
      lastSessionOpenFailure: this.lastOpenFailure ?? null,
      handshakeMs: {
        samples: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      },
      providers: [...this.providers.values()].map(({ at, ...result }) => ({
        ...result,
        checkedAt: iso(at),
        ageMs: Math.max(0, now - at),
      })),
      endReasons: Object.fromEntries(this.endReasons),
      timeouts: Object.fromEntries(this.timeouts),
      ...sources,
    };
  }
}

/** The process's live-path state: the media runtime, pre-warm and telemetry record into it. */
export const workerHealth = new WorkerHealthState();

export interface WorkerHealthOptions {
  /** `OVO_HEALTH_TOKEN`: required as a bearer token for `?verbose=1`; unset disables verbose. */
  token?: string;
  verbose?: () => Record<string, unknown>;
}

export function createWorkerHealthServer(
  port: number,
  snapshot: () => WorkerStatus,
  options: WorkerHealthOptions = {},
) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://worker');
    if (url.pathname !== '/health' && url.pathname !== '/ready') {
      response.writeHead(404).end();
      return;
    }
    const verbose = url.searchParams.get('verbose') === '1';
    if (verbose && !authorized(request, options.token)) {
      response.writeHead(options.token ? 401 : 403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: options.token ? 'unauthorized' : 'verbose_disabled' }));
      return;
    }
    const current = snapshot();
    const healthy = current.state !== 'failed';
    const ready = current.state === 'ready' || current.state === 'dial-disabled';
    response.writeHead(url.pathname === '/ready' && !ready ? 503 : healthy ? 200 : 503, {
      'content-type': 'application/json',
    });
    response.end(
      JSON.stringify({
        ...current,
        liveDialEnabled: process.env.OVO_LIVE_DIAL_ENABLED === 'true',
        ...(verbose ? { live: (options.verbose ?? (() => workerHealth.snapshot()))() } : {}),
      }),
    );
  });
  server.listen(port, '0.0.0.0');
  return server;
}

/** Constant-time bearer check; verbose health names providers and failures, so it is never open. */
export function authorized(request: Pick<IncomingMessage, 'headers'>, token?: string): boolean {
  if (!token) return false;
  const header = request.headers.authorization;
  const presented = Buffer.from(
    typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '',
  );
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
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

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)]!;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
