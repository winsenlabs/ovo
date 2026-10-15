import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { emptyAgentConfig } from '../../lib/api';
import { ConfirmDialogProvider } from '../ui/dialog';
import { InboundRoutes } from './inbound-routes';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

const route: Record<string, unknown> = {
  organizationId: 'workspace-1',
  phoneNumber: '+15551234567',
  releaseId: 'release-060',
  carrierPluginId: null,
  carrierBindingId: null,
  variables: {},
  enabled: true,
  version: 1,
  createdAt: '2026-09-25T10:00:00Z',
  updatedAt: '2026-09-25T10:00:00Z',
};

// A number pinned to a routing release (Wave 15): no agent release of its own.
const routed = {
  ...route,
  phoneNumber: '+15557654321',
  releaseId: null,
  routingReleaseId: '7d3c1a52-9b0e-4c55-8a4f-1f2e3d4c5b6a',
  routing: { pointId: 'point-1', pointName: 'Main line', version: 3 },
};
let listed: Record<string, unknown>[] = [route];

beforeEach(() => {
  listed = [route];
  request.mockReset();
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/operations/inbound/routes?')) return { data: { items: listed } };
    if (path.startsWith('/operations/inbound/routes/') && init?.method === 'PUT')
      return { data: { ...route, ...JSON.parse(String(init.body)), version: 2 } };
    if (path === '/agents')
      return {
        data: {
          items: Array.from({ length: 50 }, (_, index) => ({ id: `agent-${index + 1}` })),
        },
      };
    if (/^\/agents\/agent-\d+\/releases$/.test(path)) return { data: { items: [] } };
    if (path === '/releases/release-060')
      return {
        data: {
          id: 'release-060',
          agentId: 'agent-060',
          workspaceId: 'workspace-1',
          config: { ...emptyAgentConfig(), name: 'Bound agent 060' },
          plugins: [],
          createdAt: '2026-09-25T10:00:00Z',
        },
      };
    if (path === '/plugins?kind=carrier') return { data: { plugins: [] } };
    if (path === '/provider-bindings') return { data: { items: [] } };
    throw new Error(`Unexpected API request: ${path}`);
  });
});
afterEach(() => cleanup());
// jsdom has no modal dialogs; the route drawer only needs open and close.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

it('fetches an existing route release beyond page one and allows disabling the route', async () => {
  render(
    <ConfirmDialogProvider>
      <InboundRoutes role="admin" />
    </ConfirmDialogProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const release = screen.getByRole('combobox', { name: 'Immutable release' }) as HTMLSelectElement;
  const save = screen.getByRole('button', { name: 'Save route version' }) as HTMLButtonElement;
  await waitFor(() => expect(release.value).toBe('release-060'));
  expect(screen.getByRole('option', { name: /Bound agent 060 · release-060/ })).toBeDefined();
  expect(save.disabled).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Accept inbound admission on this route' }));
  fireEvent.click(save);
  await waitFor(() => {
    const write = request.mock.calls.find(
      ([path, init]) => path.startsWith('/operations/inbound/routes/') && init?.method === 'PUT',
    );
    expect(write).toBeDefined();
    expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({
      releaseId: 'release-060',
      enabled: false,
    });
  });
});

it('fails closed when an existing route release cannot be loaded', async () => {
  const original = request.getMockImplementation()!;
  request.mockImplementation((path: string, init?: RequestInit) =>
    path === '/releases/release-060'
      ? Promise.reject(new Error('Release gone'))
      : original(path, init),
  );
  render(
    <ConfirmDialogProvider>
      <InboundRoutes role="admin" />
    </ConfirmDialogProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await screen.findByText('Bound release unavailable: Release gone');
  expect(
    (screen.getByRole('button', { name: 'Save route version' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('renders a routed number with its routing point and release, never crashing on a null release', async () => {
  listed = [routed, { ...routed, phoneNumber: '+15550000000', routing: null }];
  render(
    <ConfirmDialogProvider>
      <InboundRoutes role="admin" />
    </ConfirmDialogProvider>,
  );
  const row = (await screen.findByText('Routing point Main line · v3')).closest('tr')!;
  expect(within(row).getByTitle(routed.routingReleaseId)).toBeDefined();
  expect(within(row).queryByText('Unknown agent')).toBeNull();
  // An API that names no point still shows the number as routed.
  expect(screen.getByText('Routing point')).toBeDefined();
});

it('warns that saving an agent release switches a routed number to that agent', async () => {
  listed = [routed];
  render(
    <ConfirmDialogProvider>
      <InboundRoutes role="admin" />
    </ConfirmDialogProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  expect(
    (await screen.findByText(/Saving an agent release here switches the number to that agent/))
      .textContent,
  ).toContain('Routing point Main line · v3');
  const release = screen.getByRole('combobox', { name: 'Immutable release' }) as HTMLSelectElement;
  expect(release.value).toBe('');
  expect(
    (screen.getByRole('button', { name: 'Save route version' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  // No bound-release lookup for a routed number: it has no agent release to load.
  expect(request.mock.calls.some(([path]) => String(path).startsWith('/releases/'))).toBe(false);
});

it('shows no routing warning when editing a direct number', async () => {
  render(
    <ConfirmDialogProvider>
      <InboundRoutes role="admin" />
    </ConfirmDialogProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await screen.findByRole('option', { name: /Bound agent 060 · release-060/ });
  expect(screen.queryByText(/switches the number to that agent/)).toBeNull();
});
