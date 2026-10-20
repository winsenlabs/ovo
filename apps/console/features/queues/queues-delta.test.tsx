import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activity } from '../../e2e/fixtures/routing-data.mjs';
import { QueuesView } from './queues-view';
import { externalRecord, managedRecord, queuesApi, resetQueues } from './queues-test-support';

vi.mock('../../lib/data/queues-api', async () =>
  (await import('./queues-test-support')).queuesApiModule(),
);
beforeEach(() => {
  resetQueues();
  queuesApi.activity.mockImplementation(async (id: string, window: string) => activity(id, window));
});
afterEach(cleanup);

describe('queue list additions', () => {
  it('links each routing point that binds a queue into the designer', async () => {
    queuesApi.list.mockResolvedValue([
      managedRecord({ usedBy: ['5b0f2d3a-1c4e-4f6a-9d21-0a7b8c9d0e11'] }),
      externalRecord(),
    ]);
    render(<QueuesView role="editor" />);
    const link = await screen.findByRole('link', { name: 'Point 5b0f2d3a' });
    expect(link.getAttribute('href')).toBe('/routing/points/5b0f2d3a-1c4e-4f6a-9d21-0a7b8c9d0e11');
  });
  it('opens a queue activity drawer from its row', async () => {
    render(<QueuesView role="viewer" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity of Support desk' }));
    await waitFor(() => expect(queuesApi.activity).toHaveBeenCalledWith('q-desk', '24h'));
    expect(await screen.findByRole('dialog', { name: 'Activity: Support desk' })).toBeTruthy();
    expect(await screen.findByText('64')).toBeTruthy();
  });
});
