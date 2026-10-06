import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import type { CapacitySignalInput } from '@winsendotai/ovo-plugin-orchestration';
import { DispatcherLoop } from './dispatcher-loop.ts';
import { dispatcherIdentity, releaseTerminalCalls } from './dispatcher-process.ts';
import { INBOUND_READINESS_KEY, publishInboundReadiness } from './inbound-readiness-store.ts';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({}, { sink: (line) => lines.push(JSON.parse(line)) });
  return { lines, logger };
}

const capacity = (): CapacitySignalInput => ({
  nowMs: Date.now(),
  observedAtMs: Date.now() - 1_000,
  maxMetricAgeMs: 15_000,
  counts: { readyIdle: 1, reserved: 0, active: 0, starting: 0, draining: 0, total: 1 },
  eligibleDueJobs: 0,
  admissionHorizon: 10,
  campaigns: [],
  inboundEnabled: false,
  inboundWarmFloor: 1,
  configuredMax: 2,
  carrierConcurrency: 2,
  providerConcurrency: 2,
  spendPermitted: 2,
  provisionedTasks: 1,
  oldestEligibleJobAgeSeconds: 0,
});

const readiness = {
  admissionEnabled: false,
  readyWorkers: 1,
  readyProtected: 0,
  warmFloor: 1,
  ready: true,
  reasons: ['OVO_INBOUND_ENABLED=false'],
};

describe('dispatcher failure visibility', () => {
  // A bare `catch {}` hid why every replica fell back to a local identity.
  it('logs why the ECS metadata identity was not used', async () => {
    const { lines, logger } = capture();
    const env = { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x' };
    const thrown = await dispatcherIdentity(
      env,
      (async () => {
        throw new Error('connect ETIMEDOUT');
      }) as unknown as typeof fetch,
      logger,
    );
    const refused = await dispatcherIdentity(
      env,
      (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
      logger,
    );
    expect(thrown).toBe(refused);
    expect(lines).toEqual([
      expect.objectContaining({
        event: 'dispatcher_identity_fallback',
        level: 'warn',
        error: 'connect ETIMEDOUT',
        identity: thrown,
      }),
      expect.objectContaining({ event: 'dispatcher_identity_fallback', status: 500 }),
    ]);
  });

  it('logs a terminal call it could not release and still releases the others', async () => {
    const { lines, logger } = capture();
    const released: string[] = [];
    const store = {
      listTerminalSessions: async () => [
        { jobId: 'job-1', sessionId: 's-1', status: 'completed' },
        { jobId: 'job-2', sessionId: 's-2', status: 'completed' },
      ],
      get: async (jobId: string) => ({ id: jobId, workspaceId: 'w', payload: {} }),
      releaseTerminalSession: async (jobId: string) => void released.push(jobId),
    };
    const control = {
      getCall: async () => ({ id: 'call' }),
      finishCall: vi
        .fn()
        .mockRejectedValueOnce(new Error('control database unavailable'))
        .mockResolvedValue(undefined),
    };
    await releaseTerminalCalls(store as never, control as never, logger);
    expect(released).toEqual(['job-2']);
    expect(lines).toEqual([
      expect.objectContaining({
        event: 'terminal_call_release_failed',
        jobId: 'job-1',
        sessionId: 's-1',
        error: 'control database unavailable',
      }),
    ]);
  });
});

describe('inbound readiness publication (OPS-4)', () => {
  it('publishes every readiness read for the API, and a failed write never stops signalling', async () => {
    const published: unknown[] = [];
    const log = vi.fn();
    const publishInbound = vi
      .fn(async (value: unknown) => void published.push(value))
      .mockRejectedValueOnce(new Error('relation does not exist'));
    const publish = vi.fn(async () => undefined);
    const loop = new DispatcherLoop({
      tasks: [],
      readCapacityInput: async () => capacity(),
      publish,
      readInboundReadiness: async () => readiness,
      publishInboundReadiness: publishInbound,
      log,
    });
    await loop.capacityTick();
    await loop.capacityTick();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(published).toEqual([readiness]);
    expect(log).toHaveBeenCalledWith({
      event: 'inbound_readiness_publish_failed',
      error: 'Error: relation does not exist',
    });
  });

  it('upserts the readiness row the API reads, never moving it backwards in time', async () => {
    const query = vi.fn(async () => ({ rowCount: 1 }));
    const at = new Date('2026-10-06T00:00:00.000Z');
    await publishInboundReadiness({ query }, readiness, at);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/ON CONFLICT \(service_key\)[\s\S]*signal_at <= EXCLUDED\.signal_at/),
      [INBOUND_READINESS_KEY, JSON.stringify(readiness), at],
    );
  });
});
