import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../lib/api';
import { IDS, resetRouting, routingApi, ENABLED_STATUS } from '../routing-test-support';
import { queuesApi } from '../../queues/queues-test-support';
import { DesignerView } from './designer-view';

vi.mock('../../../lib/data/routing-api', async (importActual) =>
  (await import('../routing-test-support')).routingApiModule(importActual as never),
);
vi.mock('../../../lib/data/queues-api', async () =>
  (await import('../../queues/queues-test-support')).queuesApiModule(),
);
const nav = { tab: 'tree' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/routing/points/x',
  useSearchParams: () => new URLSearchParams(`tab=${nav.tab}`),
}));

beforeEach(() => {
  resetRouting();
  nav.tab = 'tree';
  queuesApi.credentials.mockResolvedValue([]);
  queuesApi.list.mockResolvedValue([]);
  queuesApi.status.mockResolvedValue({
    enabled: true,
    webhookEnabled: true,
    managedAvailable: true,
    room: { configured: true },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const view = (role: 'viewer' | 'editor' | 'admin' = 'editor') =>
  render(<DesignerView pointId={IDS.point} role={role} />);
const ready = async () =>
  await screen.findByRole('heading', { level: 1, name: 'Main line' }, { timeout: 5000 });

describe('DesignerView states', () => {
  it('shows a skeleton, then the header, KPIs, map and tabs', async () => {
    view();
    expect(screen.getAllByRole('status', { name: /Loading/ }).length).toBeGreaterThan(0);
    await ready();
    expect(screen.getByText('Draft v4')).toBeTruthy();
    expect(await screen.findByText('Published v3')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Numbers (2)' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Route map as an outline' })).toBeTruthy();
    expect(screen.getByRole('tree', { name: 'Questions and branches' })).toBeTruthy();
  });
  it('says routing is not enabled when the feature is off', async () => {
    routingApi.status.mockResolvedValue({ ...ENABLED_STATUS, enabled: false });
    view();
    expect(await screen.findByText('Routing is not enabled here')).toBeTruthy();
  });
  it('says so when the point does not exist, and retries a failed load', async () => {
    routingApi.point.mockRejectedValueOnce(new ApiError(404, 'routing_point_not_found', 'missing'));
    view();
    expect(await screen.findByText('This routing point does not exist')).toBeTruthy();
    cleanup();
    resetRouting();
    routingApi.point.mockRejectedValueOnce(new ApiError(500, 'x', 'The service is down'));
    view();
    expect(await screen.findByText('The service is down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await ready();
  });
  it('shows an unavailable status as an error with retry', async () => {
    routingApi.status.mockRejectedValueOnce(new Error('status down'));
    view();
    expect(await screen.findByText('status down')).toBeTruthy();
  });
  it('lets a viewer read but not save or publish', async () => {
    view('viewer');
    await ready();
    expect(screen.getByText(/You can read this point but not change it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish…' })).toBeNull();
  });
});

describe('editing and saving', () => {
  async function editGreeting() {
    nav.tab = 'lines';
    view();
    await ready();
    fireEvent.change(await screen.findByLabelText('Greeting (en)'), {
      target: { value: 'Hello from the test' },
    });
  }
  it('marks unsaved changes and saves with the draft version', async () => {
    await editGreeting();
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(routingApi.savePoint).toHaveBeenCalled());
    const [id, draft, version] = routingApi.savePoint.mock.calls[0]!;
    expect([id, version]).toEqual([IDS.point, 4]);
    expect(draft.greeting.en).toBe('Hello from the test');
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    expect(screen.getByText('Draft v5')).toBeTruthy();
  });
  it('discards edits back to the saved draft', async () => {
    await editGreeting();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  });
  it('keeps the edits and shows what the server changed on a 409', async () => {
    const theirs = (await routingApi.point(IDS.point)).point;
    routingApi.savePoint.mockRejectedValue(
      new ApiError(409, 'routing_point_conflict', 'changed', {
        current: {
          ...theirs,
          draftVersion: 5,
          draft: { ...theirs.draft, name: 'Renamed by a teammate' },
        },
      }),
    );
    await editGreeting();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This point changed on the server.')).toBeTruthy();
    expect(screen.getByText(/The name changed/)).toBeTruthy();
    expect((screen.getByLabelText('Greeting (en)') as HTMLInputElement).value).toBe(
      'Hello from the test',
    );
    fireEvent.click(screen.getByRole('button', { name: /Keep my edits/ }));
    expect(screen.queryByText('This point changed on the server.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(routingApi.savePoint.mock.lastCall![2]).toBe(5));
  });
  it('shows a server refusal and other save failures', async () => {
    routingApi.savePoint.mockRejectedValue(new ApiError(422, 'routing_draft_invalid', 'invalid'));
    await editGreeting();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/server refused the draft/)).toBeTruthy();
  });
});

describe('issues', () => {
  it('shows instant client issues on the tab and header without a server call', async () => {
    nav.tab = 'lines';
    view();
    await ready();
    fireEvent.change(await screen.findByLabelText('Greeting (en)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove en from Greeting' }));
    expect(await screen.findByText(/No en line/)).toBeTruthy();
    expect(screen.getAllByText(/error/).length).toBeGreaterThan(0);
  });
  it('debounces the server check and merges its issues onto the node', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    routingApi.validate.mockResolvedValue([
      {
        code: 'routing_member_meter_uncovered',
        severity: 'warning',
        path: ['nodes', 0, 'branches', 0, 'target'],
        message: 'No priced meter',
      },
    ]);
    view();
    await ready();
    expect(routingApi.validate).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(routingApi.validate).toHaveBeenCalledTimes(1);
    expect((await screen.findAllByText('1 warning')).length).toBeGreaterThan(1);
    expect(routingApi.validate.mock.lastCall![0]).toBe(IDS.point);
  });
  it('skips the server check while the schema is broken', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    nav.tab = 'lines';
    view();
    await ready();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    routingApi.validate.mockClear();
    fireEvent.change(screen.getByLabelText('Wait before prompting'), { target: { value: '1' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(routingApi.validate).not.toHaveBeenCalled();
  });
});

describe('tabs', () => {
  it.each([
    ['lines', 'Every line, audited'],
    ['hold', 'Transfer targets'],
    ['queues', 'Person queues'],
    ['numbers', 'Bind a number'],
    ['releases', 'Publish…'],
    ['simulate', 'Run the simulation'],
  ])('renders the %s tab', async (tab, marker) => {
    nav.tab = tab;
    view('admin');
    await ready();
    expect((await screen.findAllByText(marker)).length).toBeGreaterThan(0);
  });
});
