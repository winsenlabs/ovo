// The load test's report: call outcomes, latency, per-process cost and the capacity estimate.
import type { CapacityEstimate, PostgresConnections, ProcessUsage } from './capacity.ts';

export interface LoadReport {
  calls: number;
  completed: number;
  failures: { index: number; error: string }[];
  firstAgentAudioMs: { p50: number | null; p95: number | null; max: number | null };
  /** End of the caller's turn to first audio, as the worker measured it (GET /v1/calls/:id/turns). */
  turnFirstAudioMs: { p50: number | null; p95: number | null };
  processes: ProcessUsage[];
  /** Connections to the run's database: the control plane alone, plus idle workers, at peak. */
  postgres: PostgresConnections;
  capacity?: CapacityEstimate;
}

export function formatLoadReport(report: LoadReport): string {
  const ms = (value: number | null) => (value === null ? '—' : `${Math.round(value)} ms`);
  const lines = [
    `# Load test: ${report.calls} concurrent calls`,
    '',
    `Completed ${report.completed}/${report.calls}.`,
    ...report.failures.map((failure) => `- call ${failure.index} failed: ${failure.error}`),
    '',
    `- Media connect to first agent audio (caller side): p50 ${ms(report.firstAgentAudioMs.p50)}, p95 ${ms(report.firstAgentAudioMs.p95)}, max ${ms(report.firstAgentAudioMs.max)}`,
    `- End of caller turn to first audio (worker turn telemetry): p50 ${ms(report.turnFirstAudioMs.p50)}, p95 ${ms(report.turnFirstAudioMs.p95)}`,
    '',
    '| Process | Mean CPU % (of one vCPU) | Peak CPU % | Peak RSS MiB | Peak event-loop p99 ms |',
    '| --- | --- | --- | --- | --- |',
    ...report.processes.map(
      (usage) =>
        `| ${usage.process} | ${usage.meanCpuPercent} | ${usage.peakCpuPercent} | ${usage.peakRssMiB} | ${usage.peakEventLoopP99Ms ?? '—'} |`,
    ),
    '',
    `Postgres connections (max_connections ${report.postgres.maxConnections}): control plane with worker-1 ${report.postgres.controlPlane}, all ${report.postgres.workers} workers idle ${report.postgres.withIdleWorkers}, peak during calls ${report.postgres.peak}.`,
    '',
  ];
  const capacity = report.capacity;
  if (capacity)
    lines.push(
      `Capacity estimate for ${capacity.machine.name} (${capacity.machine.vcpus} vCPU, ${capacity.machine.memoryGiB} GiB; ${capacity.machine.reservedVcpus} vCPU and ${capacity.machine.reservedGiB} GiB reserved, ${capacity.machine.targetUtilization * 100}% target): ` +
        `one worker per call at ${capacity.workerCpuPercent}% CPU and ${capacity.workerRssMiB} MiB, so **${capacity.concurrentCalls} concurrent calls** ` +
        `(CPU allows ${capacity.byCpu}, memory ${capacity.byMemory}, Postgres connections ${capacity.byConnections ?? 'unmeasured'}). Fixture providers make this an upper bound.`,
    );
  else
    lines.push('No child worker was sampled: run with --calls 2 or more for a capacity estimate.');
  return `${lines.join('\n')}\n`;
}
