import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { activity } from '../../e2e/fixtures/routing-data.mjs';
import { ActivityDrawer } from './activity-drawer';
import { managedRecord, activityApi, queuesApi, resetQueues } from './queues-test-support';

vi.mock('../../lib/data/queues-api', async () =>
  (await import('./queues-test-support')).queuesApiModule(),
);
vi.mock('../../lib/data/routing-api', async () =>
  (await import('./queues-test-support')).activityApiModule(),
);
beforeEach(() => {
  resetQueues();
  activityApi.queueActivity.mockImplementation(async (id: string, window: string) =>
    activity(id, window),
  );
});
afterEach(cleanup);
const act = () => activityApi.queueActivity;

describe('ActivityDrawer', () => {
  it('shows the counts, waits and outcomes, and the newest tickets as ids and codes', async () => {
    render(<ActivityDrawer record={managedRecord()} onClose={vi.fn()} />);
    expect(await screen.findByText('64')).toBeTruthy();
    expect(screen.getByText('p95 2m 11s')).toBeTruthy();
    expect(screen.getByText('resolved 41')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /call-8d41c7a/ })).toHaveLength(6);
    expect(screen.queryByText(/\+91/)).toBeNull();
    expect(act()).toHaveBeenCalledWith('q-desk', '24h');
  });
  it('loads the 7 day window on request', async () => {
    render(<ActivityDrawer record={managedRecord()} onClose={vi.fn()} />);
    await screen.findByText('64');
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '7d' } });
    await waitFor(() => expect(act()).toHaveBeenCalledWith('q-desk', '7d'));
  });
  it('says human queues are off, or that the load failed, or that nobody called', async () => {
    act().mockRejectedValueOnce(new ApiError(404, 'human_queue_disabled', 'off'));
    const { rerender } = render(<ActivityDrawer record={managedRecord()} onClose={vi.fn()} />);
    expect(await screen.findByText('Human queues are not enabled here')).toBeTruthy();
    act().mockRejectedValueOnce(new Error('activity down'));
    rerender(<ActivityDrawer record={managedRecord({ id: 'q-other' })} onClose={vi.fn()} />);
    expect(await screen.findByText('activity down')).toBeTruthy();
    act().mockResolvedValueOnce({
      ...activity('q-3', '24h'),
      tickets: [],
      stats: { ...activity('q-3', '24h').stats, byOutcome: {}, avgWaitMs: null, p95WaitMs: null },
    });
    rerender(<ActivityDrawer record={managedRecord({ id: 'q-3' })} onClose={vi.fn()} />);
    expect(await screen.findByText('No callers in this period')).toBeTruthy();
  });
});
