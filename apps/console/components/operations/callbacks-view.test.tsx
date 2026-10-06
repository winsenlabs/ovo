import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallbacksView, type CallbackRecord } from './callbacks-view';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

const callback = (over: Partial<CallbackRecord> = {}): CallbackRecord => ({
  id: 'cb-1',
  callId: 'call-1',
  dueAt: '2026-10-06T12:30:00.000Z',
  timezone: 'Asia/Kolkata',
  source: 'flow',
  node: 'cb_evening',
  disposition: 'callback:this_evening',
  reason: null,
  status: 'pending',
  dialedCallId: null,
  phone: '••••0001',
  ...over,
});

beforeEach(() => request.mockReset());
afterEach(() => cleanup());

describe('the callbacks list (AGT-15)', () => {
  it('lists pending callbacks with the due time in the caller timezone, overdue flagged', async () => {
    request.mockResolvedValue({
      data: { available: true, items: [callback()], nextCursor: null },
    });
    render(<CallbacksView role="admin" now={() => new Date('2026-10-06T13:00:00Z')} />);
    const row = (await screen.findByText('••••0001')).closest('tr')!;
    expect(within(row).getByText(/6 Oct 2026, 6:00\s?pm/i)).toBeTruthy();
    expect(within(row).getByText('Overdue')).toBeTruthy();
    expect(within(row).getByText('Flow · cb_evening')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/callbacks?status=pending');
  });

  it('dials a callback back and reloads the list', async () => {
    request.mockImplementation(async (path?: string) =>
      path?.endsWith('/dial')
        ? { data: callback({ status: 'dialed', dialedCallId: 'call-2' }) }
        : { data: { available: true, items: [callback()], nextCursor: null } },
    );
    render(<CallbacksView role="admin" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Call back now' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('/callbacks/cb-1/dial', { method: 'POST', body: '{}' }),
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });

  it('switches the filter, and keeps a viewer from acting', async () => {
    request.mockResolvedValue({
      data: { available: true, items: [callback()], nextCursor: null },
    });
    render(<CallbacksView role="viewer" />);
    expect(
      ((await screen.findByRole('button', { name: 'Call back now' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/callbacks'));
  });

  it('explains an installation without durable callbacks, and shows an API error', async () => {
    request.mockResolvedValueOnce({ data: { available: false, items: [], nextCursor: null } });
    render(<CallbacksView role="admin" />);
    expect(await screen.findByText('Callbacks need PostgreSQL')).toBeTruthy();
    cleanup();
    request.mockRejectedValueOnce(new Error('Live calling is not enabled'));
    render(<CallbacksView role="admin" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Live calling is not enabled');
  });
});
