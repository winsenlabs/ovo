import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { CallsIndexFeature } from './calls-index';

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn(),
  rows: [] as unknown[],
  filterUnavailable: false,
  status: undefined as unknown,
  statusError: false,
}));
const request = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useSearchParams: () => state.params,
  useRouter: () => ({ push: state.push }),
  usePathname: () => '/calls',
}));
vi.mock('../components/shell/session-provider', () => ({ useSession: () => ({ role: 'viewer' }) }));
vi.mock('../components/operations/agent-release-options', () => ({
  loadAgentReleaseOptions: () =>
    Promise.resolve([
      { id: 'rel_sales', agentName: 'Sales agent' },
      { id: 'rel_router', agentName: 'Front desk' },
    ]),
  loadAgentChoices: () =>
    Promise.resolve([
      { id: 'agt_sales', name: 'Sales agent' },
      { id: 'agt_billing', name: 'Billing agent' },
    ]),
}));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
vi.mock('../lib/data/use-cursor-list', () => ({
  useCursorList: () => ({
    status: 'ready',
    items: state.rows,
    filterUnavailable: state.filterUnavailable,
    hasPrevious: false,
    hasNext: false,
    error: undefined,
    refresh: vi.fn(),
  }),
}));

const route = (patch: object = {}) => ({
  routingPointId: 'point-1',
  routingReleaseId: 'rr-1',
  path: ['intent'],
  target: 'agent',
  agentId: 'agt_sales',
  releaseId: 'rel_sales',
  poolId: null,
  memberId: null,
  language: 'en',
  degraded: null,
  segments: 1,
  ...patch,
});
const outcome = (patch: object = {}) => ({
  disposition: null,
  endReason: null,
  tiers: {},
  guardrail: { flagged: 0, blocked: 0 },
  route: null,
  segments: [],
  transfers: { requested: 0, refused: 0, connected: 0, failed: 0 },
  human: null,
  ...patch,
});
const call = (id: string, patch: object = {}) => ({
  id,
  releaseId: 'rel_router',
  kind: 'live',
  status: 'completed',
  createdAt: '2026-10-20T10:00:00.000Z',
  completedAt: '2026-10-20T10:03:00.000Z',
  ...patch,
});
const enabled = { enabled: true, humanQueueEnabled: true, transferEnabled: true };

beforeEach(() => {
  state.params = new URLSearchParams();
  state.push.mockReset();
  state.rows = [];
  state.filterUnavailable = false;
  state.status = enabled;
  state.statusError = false;
  request.mockImplementation(async (path: string) => {
    if (path === '/routing/status') {
      if (state.statusError) throw new ApiError(503, 'unavailable', 'down');
      return { data: state.status };
    }
    if (path.startsWith('/routing/points'))
      return { data: { items: [{ id: 'point-1', draft: { name: 'Main line' } }] } };
    return { data: { plugins: [] } };
  });
});
afterEach(cleanup);

const rowOf = async (id: string) => (await screen.findByTitle(id)).closest('tr')!;

describe('the Route column', () => {
  it('names the point and where the call went, with the facts a reader scans for', async () => {
    state.rows = [
      call('call_full', {
        outcome: outcome({
          route: route({ segments: 3, fallbacks: 1 }),
          segments: [{}, {}, {}],
          transfers: { requested: 1, refused: 0, connected: 1, failed: 0 },
          human: { queueKey: 'desk' },
        }),
      }),
    ];
    render(<CallsIndexFeature />);
    const row = await rowOf('call_full');
    await waitFor(() => expect(within(row).getByRole('link', { name: 'Main line' })).toBeTruthy());
    expect(within(row).getByRole('link', { name: 'Main line' }).getAttribute('href')).toBe(
      '/routing/points/point-1',
    );
    expect(within(row).getByText('Sales agent')).toBeTruthy();
    for (const fact of ['3 segments', 'Transferred', 'Person', 'Fallback'])
      expect(within(row).getByText(fact)).toBeTruthy();
  });

  it('says Direct for a call that was not routed and a dash when no outcome was recorded', async () => {
    state.rows = [
      call('call_direct', { outcome: outcome() }),
      call('call_live', { outcome: null }),
    ];
    render(<CallsIndexFeature />);
    expect(within(await rowOf('call_direct')).getByText('Direct')).toBeTruthy();
    expect(within(await rowOf('call_live')).queryByText('Direct')).toBeNull();
  });

  it('shows where a call that ended or went to a person was sent', async () => {
    state.rows = [call('call_end', { outcome: outcome({ route: route({ target: 'end' }) }) })];
    render(<CallsIndexFeature />);
    expect(within(await rowOf('call_end')).getByText('Ended')).toBeTruthy();
  });
});

describe('routing filters', () => {
  it('are offered when routing is on, and write the URL like the other server filters', async () => {
    render(<CallsIndexFeature />);
    const point = await screen.findByLabelText('Routing point');
    await waitFor(() =>
      expect(within(point).getByRole('option', { name: 'Main line' })).toBeTruthy(),
    );
    fireEvent.change(point, { target: { value: 'point-1' } });
    expect(state.push).toHaveBeenLastCalledWith('/calls?routingPointId=point-1');
    fireEvent.change(screen.getByLabelText('Agent segment'), { target: { value: 'agt_billing' } });
    expect(state.push).toHaveBeenLastCalledWith('/calls?segmentAgentId=agt_billing');
    fireEvent.click(screen.getByRole('switch', { name: 'Transferred' }));
    expect(state.push).toHaveBeenLastCalledWith('/calls?transferred=1');
    fireEvent.click(screen.getByRole('switch', { name: 'Reached a person' }));
    expect(state.push).toHaveBeenLastCalledWith('/calls?human=1');
    fireEvent.click(screen.getByRole('switch', { name: 'Used a fallback' }));
    expect(state.push).toHaveBeenLastCalledWith('/calls?fallback=1');
  });

  it('read the URL: values are selected, switches are on, and each shows as a chip', async () => {
    state.params = new URLSearchParams(
      'routingPointId=point-1&segmentAgentId=agt_sales&transferred=1&human=1&fallback=1',
    );
    render(<CallsIndexFeature />);
    await waitFor(() => expect(screen.getByText('Routing point: Main line')).toBeTruthy());
    for (const chip of [
      'Agent segment: Sales agent',
      'Transferred',
      'Reached a person',
      'Used a fallback',
    ])
      expect(screen.getByRole('button', { name: `Clear ${chip}` })).toBeTruthy();
    expect((screen.getByLabelText('Agent segment') as HTMLSelectElement).value).toBe('agt_sales');
    expect((screen.getByRole('switch', { name: 'Transferred' }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('turn a switch off by removing its key', async () => {
    state.params = new URLSearchParams('transferred=1&kind=live');
    render(<CallsIndexFeature />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Transferred' }));
    expect(state.push).toHaveBeenLastCalledWith('/calls?kind=live');
  });

  it('are hidden while routing is off', async () => {
    state.status = { enabled: false };
    render(<CallsIndexFeature />);
    await screen.findByLabelText('Agent');
    await waitFor(() => expect(request).toHaveBeenCalledWith('/routing/status'));
    expect(screen.queryByLabelText('Routing point')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Transferred' })).toBeNull();
  });

  it('are hidden when the status cannot be read', async () => {
    state.statusError = true;
    render(<CallsIndexFeature />);
    await screen.findByLabelText('Agent');
    await waitFor(() => expect(request).toHaveBeenCalledWith('/routing/status'));
    expect(screen.queryByLabelText('Routing point')).toBeNull();
  });

  it('are disabled with the reason when a link carries one while routing is off', async () => {
    state.status = { enabled: false };
    state.params = new URLSearchParams('fallback=1');
    render(<CallsIndexFeature />);
    expect(
      await screen.findByText(/Routing filters are not applied\. Routing is not enabled here\./),
    ).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Used a fallback' }).matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('Routing point').matches(':disabled')).toBe(true);
  });

  it('are disabled with the reason when the API cannot apply them without call outcomes', async () => {
    state.filterUnavailable = true;
    state.params = new URLSearchParams('human=1');
    render(<CallsIndexFeature />);
    expect(
      await screen.findByText(/does not store call outcomes \(PostgreSQL only\)/),
    ).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Reached a person' }).matches(':disabled')).toBe(
      true,
    );
  });

  it('are disabled when the status says outcomes are not stored', async () => {
    state.status = { ...enabled, outcomesAvailable: false };
    state.params = new URLSearchParams('transferred=1');
    render(<CallsIndexFeature />);
    expect(await screen.findByText(/does not store call outcomes/)).toBeTruthy();
  });

  it('give a filtered empty state, and Clear all drops them with the rest', async () => {
    state.params = new URLSearchParams('transferred=1&human=1&kind=live');
    render(<CallsIndexFeature />);
    expect(await screen.findByText('No calls match. Clear filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(state.push).toHaveBeenLastCalledWith('/calls?');
  });
});
