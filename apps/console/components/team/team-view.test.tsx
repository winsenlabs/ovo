import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamView } from './team-view';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

const identity = {
  id: 'usr_1',
  label: 'Priya Menon',
  email: 'priya@sunrise.example',
  role: 'admin' as const,
};

const users = [
  {
    id: 'usr_1',
    email: 'priya@sunrise.example',
    label: 'Priya Menon',
    role: 'admin' as const,
    disabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'usr_2',
    email: 'arjun@sunrise.example',
    label: 'Arjun Rao',
    role: 'editor' as const,
    disabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'usr_4',
    email: 'night@sunrise.example',
    label: 'Night ops desk',
    role: 'editor' as const,
    disabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    if (path === '/users') return { data: { items: users } };
    throw new Error(`Unexpected request: ${path}`);
  });
  // jsdom does not implement `<dialog>.showModal()`; every other Dialog/Drawer test in this repo
  // polyfills it the same way so the `open` attribute actually reflects.
  vi.stubGlobal('HTMLDialogElement', HTMLDialogElement);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => cleanup());

describe('TeamView', () => {
  it('shows KPI chips derived from the loaded roster, not a raw list dump', async () => {
    render(<TeamView identity={identity} onSessionRevoked={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Arjun Rao')).toBeTruthy());
    const total = screen.getByText('Total users').closest('article')!;
    expect(within(total).getByText('3')).toBeTruthy();
    const disabled = screen
      .getByText('Disabled', { selector: '.ds-kpi-label' })
      .closest('article')!;
    expect(within(disabled).getByText('1')).toBeTruthy();
  });

  it('filters the table by search without a server round-trip', async () => {
    render(<TeamView identity={identity} onSessionRevoked={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Arjun Rao')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search name or email'), { target: { value: 'arjun' } });
    expect(screen.queryByText('Night ops desk')).toBeNull();
    expect(screen.getByText('Arjun Rao')).toBeTruthy();
  });

  it('opens the Add user drawer from the page header instead of showing the form above the table', async () => {
    render(<TeamView identity={identity} onSessionRevoked={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Arjun Rao')).toBeTruthy());
    // The page header's trigger and the drawer's own submit button share the label "Add user";
    // the trigger is the first one in document order.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add user' })[0]!);
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Email').closest('dialog')?.hasAttribute('open')).toBe(true);
  });

  it('tells a non-admin the page is restricted instead of rendering an empty table', () => {
    render(<TeamView identity={{ ...identity, role: 'editor' }} onSessionRevoked={vi.fn()} />);
    expect(screen.getByText(/available only to administrators/)).toBeTruthy();
  });
});
