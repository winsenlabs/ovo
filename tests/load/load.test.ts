import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { formatLoadReport, runLoad } from '../../scripts/loadtest/run.ts';

// This process's API, gateway, dispatcher and worker-1 reach the loopback fakes the run starts;
// the child workers get the same routes through scripts/loadtest/register-routed-net.mjs.
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('../e2e/support/routed-net.ts');
  return {
    ...actual,
    createNodeNet: () =>
      routedNodeNet(
        actual.createNodeNet,
        new Map(Object.entries(JSON.parse(process.env.OVO_LOADTEST_ROUTES ?? '{}'))),
      )(),
  };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error('The load test needs OVO_TEST_POSTGRES_URL (a scratch database)');
const calls = Number(process.env.OVO_LOAD_CALLS ?? 2);

describe(`load: ${calls} concurrent fake-carrier calls on one stack`, () => {
  it('answers every call, hears every reply, and reports cost per call', async () => {
    const report = await runLoad({
      postgresUrl,
      calls,
      holdMs: Number(process.env.OVO_LOAD_HOLD_MS ?? 4_000),
    });
    const text = formatLoadReport(report);
    if (process.env.OVO_LOAD_REPORT) await writeFile(process.env.OVO_LOAD_REPORT, text);
    console.log(text);
    expect(report.failures).toEqual([]);
    expect(report.completed).toBe(calls);
    expect(report.firstAgentAudioMs.max).toBeLessThan(10_000);
    expect(report.turnFirstAudioMs.p50).not.toBeNull();
    expect(report.postgres.peak).toBeGreaterThan(report.postgres.controlPlane);
    if (calls > 1) expect(report.capacity?.concurrentCalls).toBeGreaterThan(0);
  });
});
