import { describe, expect, it } from 'vitest';
import { E2_STANDARD_4, estimateCapacity, usageDuring, type Sample } from '../capacity.ts';
import { formatLoadReport, type LoadReport } from '../run.ts';

const MiB = 1024 ** 2;

describe('load-test capacity arithmetic', () => {
  it('summarises each process over the window when every call was up', () => {
    const samples: Sample[] = [
      { process: 'worker-2', atMs: 0, cpuPercent: 90, rssBytes: 100 * MiB },
      { process: 'worker-2', atMs: 1_000, cpuPercent: 10, rssBytes: 300 * MiB, eventLoopP99Ms: 20 },
      { process: 'worker-2', atMs: 2_000, cpuPercent: 20, rssBytes: 320 * MiB, eventLoopP99Ms: 40 },
      { process: 'parent', atMs: 1_500, cpuPercent: 30, rssBytes: 500 * MiB },
      { process: 'worker-2', atMs: 9_000, cpuPercent: 99, rssBytes: 900 * MiB },
    ];
    expect(usageDuring(samples, { fromMs: 500, toMs: 5_000 })).toEqual([
      {
        process: 'parent',
        meanCpuPercent: 30,
        peakCpuPercent: 30,
        peakRssMiB: 500,
        peakEventLoopP99Ms: null,
      },
      {
        process: 'worker-2',
        meanCpuPercent: 15,
        peakCpuPercent: 20,
        peakRssMiB: 320,
        peakEventLoopP99Ms: 40,
      },
    ]);
  });

  it('takes the tightest of CPU, memory and Postgres connections', () => {
    const workers = [
      {
        process: 'worker-2',
        meanCpuPercent: 5,
        peakCpuPercent: 40,
        peakRssMiB: 350,
        peakEventLoopP99Ms: 30,
      },
      {
        process: 'worker-3',
        meanCpuPercent: 7,
        peakCpuPercent: 45,
        peakRssMiB: 340,
        peakEventLoopP99Ms: 30,
      },
    ];
    // (4 - 1) vCPU x 70% / 6% = 35 by CPU; (16 - 4) GiB / 350 MiB = 35 by memory.
    expect(estimateCapacity(workers)).toMatchObject({
      workerCpuPercent: 6,
      byCpu: 35,
      byMemory: 35,
      concurrentCalls: 35,
    });
    // 4 workers: control plane 20, peak 68, so 16 per extra worker; (100 - 3 - 20) / 16 + 1 = 5.
    const postgres = {
      maxConnections: 100,
      controlPlane: 20,
      withIdleWorkers: 55,
      peak: 68,
      workers: 4,
    };
    expect(estimateCapacity(workers, postgres)).toMatchObject({
      connectionsPerWorker: 16,
      byConnections: 5,
      concurrentCalls: 5,
    });
    expect(estimateCapacity(workers, { ...postgres, maxConnections: 300 })?.byConnections).toBe(18);
    expect(estimateCapacity([], postgres, E2_STANDARD_4)).toBeUndefined();
  });

  it('reports failures and the connection limit in the markdown report', () => {
    const report: LoadReport = {
      calls: 2,
      completed: 1,
      failures: [{ index: 1, error: 'no agent audio within 30000 ms' }],
      firstAgentAudioMs: { p50: 1_100, p95: 1_200, max: 1_200 },
      turnFirstAudioMs: { p50: 60, p95: 80 },
      processes: [],
      postgres: {
        maxConnections: 100,
        controlPlane: 20,
        withIdleWorkers: 32,
        peak: 36,
        workers: 2,
      },
    };
    const text = formatLoadReport(report);
    expect(text).toContain('Completed 1/2.');
    expect(text).toContain('call 1 failed: no agent audio within 30000 ms');
    expect(text).toContain('max_connections 100');
    expect(text).toContain('run with --calls 2 or more');
  });
});
