import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { ENABLED_STATUS, IDS, resetRouting, routingApi } from './routing-test-support';
import { NumbersTab } from './designer/numbers-tab';
import { ReleasesTab } from './designer/releases-tab';
import { SimulateFeature } from './simulate/simulate-feature';
import { PoolFeature } from './pools/pool-feature';
import { DesignerFeature } from './designer/designer-feature';

vi.mock('../../lib/data/routing-api', async (importActual) =>
  (await import('./routing-test-support')).routingApiModule(importActual as never),
);
vi.mock('../../lib/data/queues-api', async () =>
  (await import('../queues/queues-test-support')).queuesApiModule(),
);
const params = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/routing',
  useSearchParams: () => params,
}));
vi.mock('../../components/shell/session-provider', () => ({
  useSession: () => ({ role: 'admin' }),
}));
vi.mock('../../lib/api', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/api')>();
  return {
    ...actual,
    apiRequest: vi.fn().mockResolvedValue({ data: { config: { timezone: 'Asia/Kolkata' } } }),
  };
});

beforeEach(() => {
  resetRouting();
  for (const key of [...params.keys()]) params.delete(key);
});
afterEach(cleanup);

describe('list tabs', () => {
  it('shows a loading state, then an error with retry, for the release history', async () => {
    routingApi.releases.mockRejectedValueOnce(new Error('releases down'));
    render(
      <ReleasesTab pointId={IDS.point} numbers={[]} canEdit refreshKey={0} onPublish={vi.fn()} />,
    );
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(await screen.findByText('releases down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('v3')).toBeTruthy();
  });
  it('says no numbers are on a point yet', async () => {
    render(
      <NumbersTab
        pointId={IDS.point}
        pointName="Main line"
        numbers={[]}
        isAdmin
        refreshKey={0}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText('No numbers on this point yet')).toBeTruthy();
  });
});

describe('SimulateFeature', () => {
  it('says routing is off, or could not be loaded', async () => {
    routingApi.status.mockResolvedValue({ ...ENABLED_STATUS, enabled: false });
    render(<SimulateFeature />);
    expect(await screen.findByText('Routing is not enabled here')).toBeTruthy();
    cleanup();
    routingApi.status.mockRejectedValue(new Error('status down'));
    render(<SimulateFeature />);
    expect(await screen.findByText('status down')).toBeTruthy();
  });
  it('offers to create a point when there are none, and shows a points error', async () => {
    routingApi.points.mockResolvedValue([]);
    render(<SimulateFeature />);
    expect(await screen.findByText('No routing points yet')).toBeTruthy();
    cleanup();
    routingApi.points.mockRejectedValue(new Error('points down'));
    render(<SimulateFeature />);
    expect(await screen.findByText('points down')).toBeTruthy();
  });
  it('opens the chosen point, or the point of a release from the link', async () => {
    params.set('release', IDS.r3);
    render(<SimulateFeature />);
    expect(await screen.findByRole('button', { name: 'Run the simulation' })).toBeTruthy();
    expect(routingApi.release).toHaveBeenCalledWith(IDS.r3);
    expect(routingApi.point).toHaveBeenCalledWith(IDS.point);
    expect((screen.getByLabelText('Run') as HTMLSelectElement).value).toBe(IDS.r3);
  });
  it('shows the point error with a retry', async () => {
    params.set('point', IDS.point);
    routingApi.point.mockRejectedValueOnce(new ApiError(500, 'x', 'point down'));
    render(<SimulateFeature />);
    expect(await screen.findByText('point down')).toBeTruthy();
  });
});

describe('page features', () => {
  it('render the designer and pool editors for the signed-in role', async () => {
    render(<DesignerFeature pointId={IDS.point} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Main line' })).toBeTruthy();
    cleanup();
    render(<PoolFeature poolId={IDS.sales} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sales' })).toBeTruthy();
  });
});
