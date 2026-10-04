import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyAgentConfig } from '../lib/api';
import { AgentStudio } from './studio';
import { SessionExpiryBoundary } from './shell/session-expiry-boundary';
import fixture from '../e2e/fixtures/console.json';

const request = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('../lib/api', async (original) => ({
  ...(await original<typeof import('../lib/api')>()),
  apiRequest: request,
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const draft = (id: string) => ({
  id,
  draftVersion: '1',
  config: {
    ...emptyAgentConfig(),
    name: `Agent ${id}`,
    script: {
      start: 'start',
      maxVisits: 20,
      nodes: [{ id: 'start', prompt: 'Hello', terminal: true, transitions: [] }],
    },
  },
});
const richDraft = fixture.agents.find((agent) => agent.id === 'agent-119')!;

beforeEach(() => {
  request.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/agents') return { data: { items: [richDraft] } };
    if (path === '/agents/agent-119') return { data: richDraft };
    if (path === '/agents/agent-060' && init?.method === 'PUT')
      return {
        data: { ...draft('agent-060'), config: JSON.parse(String(init.body)).config },
      };
    if (path === '/agents/agent-060') return { data: draft('agent-060') };
    if (path === '/provider-bindings') return { data: { items: [] } };
    if (path.endsWith('/releases')) return { data: { items: [] } };
    if (path.endsWith('/readiness'))
      return {
        data: {
          releaseReady: false,
          requiredPluginIds: [],
          blockers: ['Not ready'],
          liveReady: false,
        },
      };
    throw new Error(`Unexpected API request: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('console production surfaces', () => {
  it('disables actual AgentStudio authoring controls for a viewer', async () => {
    const { container } = render(
      <AgentStudio extensions={[]} identity={{ role: 'viewer' }} preferredAgentId="agent-119" />,
    );
    await screen.findByRole('heading', { name: 'Fixture agent 119' });
    const editors = container.querySelector('.studio-layout > .stack')!;
    const controls = [...editors.querySelectorAll('input, textarea, select, button')];
    expect(controls.length).toBeGreaterThan(70);
    const enabled = controls.filter((control) => control.matches(':enabled'));
    expect(
      enabled.length,
      `${enabled.length} of ${controls.length} authoring controls enabled`,
    ).toBe(0);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum node visits' }), {
      target: { value: '21' },
    });
    expect(request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('loads and saves the exact deep-linked agent past the first page', async () => {
    render(
      <AgentStudio extensions={[]} identity={{ role: 'admin' }} preferredAgentId="agent-060" />,
    );
    await screen.findByRole('heading', { name: 'Agent agent-060' });
    expect(
      (screen.getByRole('combobox', { name: 'Selected agent' }) as HTMLSelectElement).value,
    ).toBe('agent-060');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum node visits' }), {
      target: { value: '21' },
    });
    await waitFor(
      () => {
        expect(
          request.mock.calls.some(
            ([path, init]) => path === '/agents/agent-060' && init?.method === 'PUT',
          ),
        ).toBe(true);
      },
      { timeout: 1800 },
    );
    expect(
      request.mock.calls.some(
        ([path, init]) => path === '/agents/agent-001' && init?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it('unmounts protected children and redirects when a production API request returns 401', async () => {
    window.history.replaceState(null, '', '/agents/agent-060?tab=plugins');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        text: async () => JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' } }),
        headers: new Headers(),
      }),
    );
    render(
      <SessionExpiryBoundary>
        <p>Protected agent draft</p>
      </SessionExpiryBoundary>,
    );
    const { apiRequest } = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    await act(async () => {
      await expect(apiRequest('/agents')).rejects.toMatchObject({ status: 401 });
    });
    expect(screen.queryByText('Protected agent draft')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Your session ended');
    expect(router.replace).toHaveBeenCalledWith(
      '/login?next=%2Fagents%2Fagent-060%3Ftab%3Dplugins',
    );
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});
