import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InfrastructureView } from './infrastructure-view';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

afterEach(() => {
  cleanup();
  request.mockReset();
});

it('renders the current infrastructure response without an obsolete capacity-write field', async () => {
  request.mockResolvedValue({
    data: {
      organizationId: 'workspace-1',
      generatedAt: '2026-10-02T00:00:00Z',
      filter: { releaseId: null },
      installation: { enabled: true, status: 'ready', reasons: [], admissionSafety: 'Ready' },
      workers: {
        ready: 1,
        busy: 0,
        reserved: 0,
        active: 0,
        starting: 0,
        draining: 0,
        total: 1,
        capacityCeiling: 1,
        freshestHeartbeatAt: '2026-10-02T00:00:00Z',
        heartbeatMaxAgeMs: 30_000,
        sampledWorkers: 1,
        samplesTruncated: false,
      },
      queue: { depth: 2, eligibleDepth: 1, oldestAgeMs: 100, reconciliationDepth: 0 },
      capacity: { lastSignal: null, ageMs: null, maxAgeMs: 30_000 },
      providers: { quotas: null, throttling: null },
      process: {
        cpuPercentAverage: null,
        memoryRssBytesTotal: null,
        memoryLimitBytesTotal: null,
        eventLoopLagMsMax: null,
        restartsTotal: null,
      },
      recordings: null,
      telemetry: null,
    },
  });
  render(<InfrastructureView />);
  expect(await screen.findByText('Durable queue')).toBeDefined();
  expect(screen.getByText('Capacity ceiling')).toBeDefined();
  expect(screen.queryByText('Unresolved capacity writes')).toBeNull();
});
