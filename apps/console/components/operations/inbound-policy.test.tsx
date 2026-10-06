import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InboundPolicy } from './inbound-policy';

// OPS-4: the page showed "0 protected ready" with no reason while OVO_INBOUND_ENABLED was still
// false, so readiness could not be verified before go-live.
const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));
afterEach(() => {
  cleanup();
  request.mockReset();
});

const readiness = {
  admissionEnabled: false,
  readyWorkers: 1,
  readyProtected: 0,
  warmFloor: 2,
  ready: true,
  reasons: [
    'OVO_INBOUND_ENABLED=false: workers register no protected inbound slot, so readyProtected is 0 by design',
  ],
  observedAt: '2026-10-06T00:00:00.000Z',
  ageMs: 4_000,
  stale: false,
};

function serve(capacity: Record<string, unknown>) {
  request.mockImplementation(async (path: string) => {
    if (path === '/operations/inbound/policy') return { data: { policy: null } };
    if (path === '/operations/inbound/capacity') return { data: capacity };
    throw new Error(`Unexpected API request: ${path}`);
  });
}

it('shows the dispatcher’s readiness and why readyProtected is zero before go-live', async () => {
  serve({ readyProtected: 0, readiness });
  render(<InboundPolicy role="admin" />);
  expect(await screen.findByText('Ready to enable inbound admission')).toBeTruthy();
  expect(screen.getByText(/Admission disabled · 1 ready worker · warm floor 2/)).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Readiness reasons' }).textContent).toContain(
    'OVO_INBOUND_ENABLED=false',
  );
  expect(screen.getByText('0 protected ready')).toBeTruthy();
});

it('warns when the readiness report is stale or no dispatcher has published one', async () => {
  serve({ readyProtected: 0, readiness: { ...readiness, stale: true, ageMs: 120_000 } });
  render(<InboundPolicy role="viewer" />);
  expect(await screen.findByText('Readiness report is stale')).toBeTruthy();
  cleanup();
  serve({ readyProtected: 0, readiness: null });
  render(<InboundPolicy role="viewer" />);
  expect(await screen.findByText(/No dispatcher has reported inbound readiness yet/)).toBeTruthy();
});
