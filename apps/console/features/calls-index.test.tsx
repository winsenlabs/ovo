import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallsIndexFeature } from './calls-index';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/calls',
}));
vi.mock('../components/shell/session-provider', () => ({
  useSession: () => ({ role: 'viewer' }),
}));
vi.mock('../components/operations/agent-release-options', () => ({
  loadAgentReleaseOptions: () => Promise.resolve([{ id: 'rel_1', agentName: 'EMI reminder' }]),
}));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: () => Promise.resolve({ data: { plugins: [] } }) };
});
vi.mock('../lib/data/use-cursor-list', () => ({
  useCursorList: () => ({
    status: 'ready',
    items: [
      {
        id: 'call_recorded',
        releaseId: 'rel_1',
        kind: 'live',
        status: 'completed',
        createdAt: '2026-10-15T10:00:00.000Z',
        completedAt: '2026-10-15T10:03:00.000Z',
        outcome: {
          disposition: 'promise_to_pay',
          finalNode: 'goodbye',
          endReason: 'error:timeout:route_resolve',
          tiers: { jev: 3 },
          guardrail: { flagged: 0, blocked: 0 },
        },
      },
      {
        id: 'call_live',
        releaseId: 'rel_1',
        kind: 'live',
        status: 'in_progress',
        createdAt: '2026-10-15T10:10:00.000Z',
        completedAt: null,
        outcome: null,
      },
    ],
    hasPrevious: false,
    hasNext: false,
    error: undefined,
    refresh: vi.fn(),
  }),
}));
afterEach(() => cleanup());

describe('calls index (AGT-8, W14 relogic)', () => {
  it('humanises disposition and names the stage a call timed out in (OBS-9)', async () => {
    render(<CallsIndexFeature />);
    const recorded = (await screen.findByTitle('call_recorded')).closest('tr')!;
    expect(within(recorded).getByText('Promise to pay')).toBeTruthy();
    expect(within(recorded).getByText(/Timed out · Route resolve/)).toBeTruthy();
    expect(within(recorded).getByText('Completed')).toBeTruthy();
  });

  it('shows a live call as in progress with no duration yet', async () => {
    render(<CallsIndexFeature />);
    const live = (await screen.findByTitle('call_live')).closest('tr')!;
    expect(within(live).getByText('In progress')).toBeTruthy();
  });

  it('resolves the agent name from the release, not the (missing) call field', async () => {
    render(<CallsIndexFeature />);
    expect((await screen.findAllByText('EMI reminder')).length).toBeGreaterThan(0);
  });

  it('shows a KPI strip summarising the loaded window', async () => {
    render(<CallsIndexFeature />);
    expect(await screen.findByText('Calls (window)')).toBeTruthy();
    expect(await screen.findByText('Live now')).toBeTruthy();
  });
});
