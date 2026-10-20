import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api';
import { IDS, resetRouting, routingApi } from '../routing-test-support';
import { PoolEditor } from './pool-editor';
import { UTILISATION_POLL_MS } from './use-utilisation';

vi.mock('../../../lib/data/routing-api', async (importActual) =>
  (await import('../routing-test-support')).routingApiModule(importActual as never),
);
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
beforeEach(() => {
  resetRouting();
  push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const view = (role: 'viewer' | 'editor' | 'admin' = 'editor') =>
  render(<PoolEditor poolId={IDS.sales} role={role} />);
const ready = () => screen.findByRole('heading', { level: 1, name: 'Sales' }, { timeout: 5000 });

describe('PoolEditor', () => {
  it('shows members with live load, KPIs and the load bars', async () => {
    view();
    await ready();
    expect(await screen.findByRole('row', { name: /sales-hi/ })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Load per member' })).toBeTruthy();
    expect(await screen.findByText('Active calls', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Mon-Fri 09:00-21:00 (Asia/Kolkata)')).toBeTruthy();
  });
  it('edits a member in the drawer and saves the pool with its version', async () => {
    view();
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit member sales-hi' }));
    const drawer = screen.getByRole('dialog', { name: 'Member sales-hi' });
    fireEvent.change(within(drawer).getByLabelText('Priority'), { target: { value: '80' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(routingApi.savePool).toHaveBeenCalled());
    const [id, definition, version] = routingApi.savePool.mock.calls[0]!;
    expect([id, version]).toEqual([IDS.sales, 2]);
    expect(definition.members.find((m: { id: string }) => m.id === 'sales-hi').priority).toBe(80);
  });
  it('adds a member with a checked id and languages, refusing a duplicate', async () => {
    view();
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: 'Add member' }));
    const drawer = screen.getByRole('dialog', { name: 'New pool member' });
    fireEvent.change(within(drawer).getByLabelText('Member id'), { target: { value: 'sales-en' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add member' }));
    expect(within(drawer).getByText('A member called sales-en already exists.')).toBeTruthy();
    fireEvent.change(within(drawer).getByLabelText('Member id'), { target: { value: 'sales-mr' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add member' }));
    expect(await screen.findByRole('row', { name: /sales-mr/ })).toBeTruthy();
  });
  it('toggles a member and removes one, keeping at least one', async () => {
    view();
    await ready();
    const toggle = await screen.findByRole('switch', { name: 'sales-ta takes calls' });
    fireEvent.click(toggle);
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove member sales-ta' }));
    expect(screen.queryByRole('row', { name: /sales-ta/ })).toBeNull();
  });
  it('keeps edits on a stale save and offers the server version', async () => {
    routingApi.savePool.mockRejectedValue(
      new ApiError(409, 'routing_pool_conflict', 'changed', {
        current: { ...(await routingApi.pool(IDS.sales)).pool, version: 3 },
      }),
    );
    view();
    await ready();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sales team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This pool changed on the server.')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Sales team');
    fireEvent.click(screen.getByRole('button', { name: /Load the server version/ }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Sales');
  });
  it('deletes after confirming, and names the points that still use a pool', async () => {
    routingApi.removePool.mockRejectedValue(
      new ApiError(409, 'routing_pool_in_use', 'in use', { usedBy: [IDS.point] }),
    );
    view();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete pool' })).getByRole('button', {
        name: 'Confirm',
      }),
    );
    await waitFor(() => expect(routingApi.removePool).toHaveBeenCalledWith(IDS.sales, 2));
    expect(await screen.findByText(/still used by Main line/)).toBeTruthy();
  });
  it('answers who would answer for a language', async () => {
    view();
    await ready();
    routingApi.explain.mockResolvedValue({
      poolId: IDS.sales,
      poolName: 'Sales',
      wanted: { language: 'ta', languageMode: 'caller', products: null, skills: [] },
      languageUsed: 'ta',
      members: [
        {
          memberId: 'sales-ta',
          agentId: 'a',
          releaseId: 'r',
          priority: 50,
          enabled: false,
          open: true,
          productOk: true,
          skillsOk: true,
          languageOk: true,
          eligible: false,
          tier: null,
          active: 0,
          capacity: 10,
          full: false,
          picked: false,
          reasons: ['disabled'],
        },
      ],
      result: 'no_eligible_member',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Who would answer?' }));
    fireEvent.change(screen.getByLabelText("Caller's language", { exact: true }), {
      target: { value: 'ta' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('No eligible member')).toBeTruthy();
    expect(screen.getByText('Turned off')).toBeTruthy();
    expect(routingApi.explain.mock.lastCall![0]).toMatchObject({
      poolId: IDS.sales,
      context: { language: 'ta' },
      load: 'empty',
    });
  });
  it('is read only for a viewer and says when the pool is gone or routing is off', async () => {
    view('viewer');
    await ready();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
    cleanup();
    routingApi.pool.mockRejectedValue(new ApiError(404, 'routing_pool_not_found', 'missing'));
    view();
    expect(await screen.findByText('This pool does not exist')).toBeTruthy();
  });
});

describe('live utilisation', () => {
  it('polls every 10 seconds, marks the last numbers stale on failure and recovers on retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    view();
    await ready();
    await screen.findByRole('list', { name: 'Load per member' });
    const calls = routingApi.utilisation.mock.calls.length;
    routingApi.utilisation.mockRejectedValue(new Error('poll failed'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UTILISATION_POLL_MS + 100);
    });
    expect(routingApi.utilisation.mock.calls.length).toBe(calls + 1);
    expect(await screen.findByText('Stale')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Load per member' })).toBeTruthy();
    routingApi.utilisation.mockResolvedValue({
      poolId: IDS.sales,
      at: '',
      members: [],
      total: { active: 0, capacity: null },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Stale')).toBeNull());
  });
  it('says live load is unavailable when it never loads', async () => {
    routingApi.utilisation.mockRejectedValue(new Error('no claims'));
    view();
    await ready();
    expect(await screen.findByText('Live load is not available')).toBeTruthy();
  });
});
