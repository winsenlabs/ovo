import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import {
  externalRecord,
  managedRecord,
  queuesApi,
  resetQueues,
  roomStatus,
} from './queues-test-support';
import { QueuesView } from './queues-view';

vi.mock('../../lib/data/queues-api', async () =>
  (await import('./queues-test-support')).queuesApiModule(),
);
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: vi.fn(async () => ({ data: { items: [] } })),
}));

beforeEach(resetQueues);
afterEach(() => cleanup());

describe('Human queues list', () => {
  it('lists each queue with its type, live waiting count and readiness', async () => {
    render(<QueuesView role="admin" />);
    const table = await screen.findByRole('region', { name: 'Human queues' });
    const desk = within(table).getByText('Support desk').closest('tr')!;
    expect(within(desk).getByText('Operator desk')).toBeTruthy();
    expect(within(desk).getByText('Open pick-up')).toBeTruthy();
    expect(within(desk).getByText(/^3 \(/)).toBeTruthy();
    expect(within(desk).getByText('Ready')).toBeTruthy();
    const acd = within(table).getByText('Acme ACD').closest('tr')!;
    expect(within(acd).getByText('Webhook')).toBeTruthy();
    expect(screen.getByText('Waiting now').closest('article')?.textContent).toContain('3');
  });

  it('says when webhooks are off or no room server exists, instead of showing Ready', async () => {
    queuesApi.status.mockResolvedValue(
      roomStatus({ webhookEnabled: false, managedAvailable: false, room: { configured: false } }),
    );
    render(<QueuesView role="admin" />);
    await screen.findByRole('region', { name: 'Human queues' });
    expect(screen.getByText('Webhook off')).toBeTruthy();
    expect(screen.getByText('Room not available')).toBeTruthy();
    expect(screen.getByText(/no room server is configured/)).toBeTruthy();
    expect(screen.getByText('Outbound webhooks are switched off here')).toBeTruthy();
  });

  it('shows the unavailable state when the feature is switched off', async () => {
    queuesApi.status.mockResolvedValue(roomStatus({ enabled: false }));
    render(<QueuesView role="admin" />);
    expect(await screen.findByText('Human queues are not enabled here')).toBeTruthy();
  });

  it('offers Retry after a failure and recovers', async () => {
    queuesApi.list.mockRejectedValueOnce(new Error('database down'));
    render(<QueuesView role="admin" />);
    expect(await screen.findByText('database down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Human queues' })).toBeTruthy();
  });

  it('shows an empty state with the next action', async () => {
    queuesApi.list.mockResolvedValue([]);
    render(<QueuesView role="editor" />);
    expect(await screen.findByText('No queues yet')).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: 'New operator desk queue' }).length,
    ).toBeGreaterThan(0);
  });

  it('hides create, edit, delete and tests from a viewer', async () => {
    render(<QueuesView role="viewer" />);
    await screen.findByRole('region', { name: 'Human queues' });
    expect(screen.queryByRole('button', { name: /New .* queue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send test webhook/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Operators' })).toBeNull();
    expect(screen.getByRole('button', { name: 'View Support desk' })).toBeTruthy();
  });

  it('lets only an admin send a test webhook, and shows each attempt', async () => {
    queuesApi.testWebhook.mockResolvedValue({
      request: {
        url: 'https://acd.example.com/ovo/handoff',
        headers: { 'x-ovo-signature': 'v1=…' },
        body: { test: true },
      },
      attempts: [
        { attempt: 1, outcome: 'retry', status: 503, ms: 120 },
        { attempt: 2, outcome: 'delivered', status: 200, ms: 80 },
      ],
      answer: { kind: 'accepted', destination: { e164: '+9140123' } },
    });
    render(<QueuesView role="admin" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test webhook for Acme ACD' }));
    expect(await screen.findByText('Test result')).toBeTruthy();
    expect(queuesApi.testWebhook).toHaveBeenCalledWith('q-acd');
    expect(screen.getByText('HTTP 503')).toBeTruthy();
    expect(screen.getByText(/Answer:/).textContent).toContain('Accepted');
    expect(screen.getByText(/No ticket was created/)).toBeTruthy();
  });

  it('reports a failed test without a stack of internals', async () => {
    queuesApi.testWebhook.mockRejectedValue(
      new ApiError(503, 'webhook_disabled', 'Webhooks are off'),
    );
    render(<QueuesView role="admin" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send test webhook for Acme ACD' }));
    expect(await screen.findByText('Webhooks are off')).toBeTruthy();
  });
});

describe('deleting a queue', () => {
  it('confirms, then deletes with the row version', async () => {
    queuesApi.remove.mockResolvedValue(undefined);
    render(<QueuesView role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Acme ACD' }));
    const dialog = await screen.findByRole('dialog');
    expect(queuesApi.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(queuesApi.remove).toHaveBeenCalledWith('q-acd', 5));
    await waitFor(() => expect(queuesApi.list).toHaveBeenCalledTimes(2));
  });

  it('names the routing points that still bind a queue', async () => {
    queuesApi.remove.mockRejectedValue(
      new ApiError(409, 'queue_in_use', 'in use', { inUseBy: ['Sales line', 'Support line'] }),
    );
    render(<QueuesView role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Support desk' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm' }),
    );
    expect(
      await screen.findByText(/still bound by routing points: Sales line, Support line/),
    ).toBeTruthy();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    render(<QueuesView role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Support desk' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(queuesApi.remove).not.toHaveBeenCalled();
  });
});

describe('new queue entry points', () => {
  it('opens the drawer for each kind', async () => {
    render(<QueuesView role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'New webhook queue' }));
    expect(await screen.findByRole('dialog', { name: 'New webhook queue' })).toBeTruthy();
    expect(screen.getByLabelText(/Endpoint URL/)).toBeTruthy();
  });

  it('opens an existing queue for editing', async () => {
    render(<QueuesView role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Support desk' }));
    expect(await screen.findByRole('dialog', { name: 'Edit Support desk' })).toBeTruthy();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Support desk');
  });
});

void [managedRecord, externalRecord];
