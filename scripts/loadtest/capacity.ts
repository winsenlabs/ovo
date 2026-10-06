// Turns the load run's samples into per-call cost and a capacity estimate for one VM.

export interface Sample {
  /** `parent` is the API, gateway, dispatcher, worker-1, fake providers and fake callers. */
  process: string;
  atMs: number;
  cpuPercent: number;
  rssBytes: number;
  eventLoopP99Ms?: number;
}

export interface MachineShape {
  name: string;
  vcpus: number;
  memoryGiB: number;
  /** Left for Postgres, API, gateway, dispatcher, console, Caddy and the OS. */
  reservedVcpus: number;
  reservedGiB: number;
  /** Fraction of the remaining CPU the workers may use at peak. */
  targetUtilization: number;
}

/** GCP e2-standard-4 with the Compose stack's other services on the same host. */
export const E2_STANDARD_4: MachineShape = {
  name: 'e2-standard-4',
  vcpus: 4,
  memoryGiB: 16,
  reservedVcpus: 1,
  reservedGiB: 4,
  targetUtilization: 0.7,
};

const GiB = 1024 ** 3;
/** Whole calls, without losing one to floating-point error (2.1 x 100 / 6 is 34.999…). */
const whole = (value: number) => Math.floor(value + 1e-9);

export interface ProcessUsage {
  process: string;
  meanCpuPercent: number;
  peakCpuPercent: number;
  peakRssMiB: number;
  peakEventLoopP99Ms: number | null;
}

function round(value: number, digits = 1): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

/** Each process's CPU and memory over the window when every call was up. */
export function usageDuring(
  samples: readonly Sample[],
  window: { fromMs: number; toMs: number },
): ProcessUsage[] {
  const inside = samples.filter((s) => s.atMs >= window.fromMs && s.atMs <= window.toMs);
  const names = [...new Set(inside.map((sample) => sample.process))].sort();
  return names.map((name) => {
    const mine = inside.filter((sample) => sample.process === name);
    const loops = mine.flatMap((sample) =>
      sample.eventLoopP99Ms === undefined ? [] : [sample.eventLoopP99Ms],
    );
    return {
      process: name,
      meanCpuPercent: round(mine.reduce((sum, s) => sum + s.cpuPercent, 0) / mine.length),
      peakCpuPercent: round(Math.max(...mine.map((s) => s.cpuPercent))),
      peakRssMiB: round(Math.max(...mine.map((s) => s.rssBytes)) / 1024 ** 2),
      peakEventLoopP99Ms: loops.length ? round(Math.max(...loops)) : null,
    };
  });
}

export interface PostgresConnections {
  maxConnections: number;
  /** API, gateway, dispatcher and worker-1 (and the run's own reader). */
  controlPlane: number;
  withIdleWorkers: number;
  peak: number;
  workers: number;
}

type Queryable = { query<R>(sql: string): Promise<{ rows: R[] }> };

export async function connectionCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    'SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()',
  );
  return Number(rows[0]!.count);
}

export async function maxConnections(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ max_connections: string }>('SHOW max_connections');
  return Number(rows[0]!.max_connections);
}

export interface CapacityEstimate {
  machine: MachineShape;
  /** Mean CPU of one worker process on one call, in percent of a vCPU. */
  workerCpuPercent: number;
  workerRssMiB: number;
  byCpu: number;
  byMemory: number;
  /** Worker processes Postgres can still connect at the peak per-worker count; 3 kept for admin. */
  byConnections?: number;
  /** Peak connections one worker held on a call. */
  connectionsPerWorker?: number;
  /** Concurrent calls, one worker process each: the smallest of the limits. */
  concurrentCalls: number;
}

/**
 * Concurrent calls one machine sustains, one worker process per call (as Compose runs them): the
 * CPU budget left after the reservation, at the target utilisation, over a worker's mean CPU on a
 * call, and the memory left over a worker's peak RSS. Fixture providers do no TLS or real codec
 * work, so treat the result as an upper bound and keep the margin the runbook gives.
 */
export function estimateCapacity(
  workers: readonly ProcessUsage[],
  postgres?: PostgresConnections,
  machine: MachineShape = E2_STANDARD_4,
): CapacityEstimate | undefined {
  if (!workers.length) return undefined;
  const perWorker =
    postgres && postgres.workers > 1
      ? Math.ceil((postgres.peak - postgres.controlPlane) / (postgres.workers - 1))
      : undefined;
  const byConnections =
    postgres && perWorker && perWorker > 0
      ? whole((postgres.maxConnections - 3 - postgres.controlPlane) / perWorker) + 1
      : undefined;
  const cpu = workers.reduce((sum, worker) => sum + worker.meanCpuPercent, 0) / workers.length;
  const rss = Math.max(...workers.map((worker) => worker.peakRssMiB));
  const byCpu = whole(
    ((machine.vcpus - machine.reservedVcpus) * machine.targetUtilization * 100) /
      Math.max(cpu, 0.1),
  );
  const byMemory = whole(((machine.memoryGiB - machine.reservedGiB) * GiB) / (rss * 1024 ** 2));
  return {
    machine,
    workerCpuPercent: round(cpu),
    workerRssMiB: round(rss),
    byCpu,
    byMemory,
    ...(byConnections === undefined ? {} : { byConnections, connectionsPerWorker: perWorker }),
    concurrentCalls: Math.min(byCpu, byMemory, byConnections ?? Infinity),
  };
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
