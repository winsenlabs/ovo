import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPluginsFeature } from '../features/agent-plugins';
import { SessionProvider } from './shell/session-provider';
import { emptyAgentConfig } from '../lib/api';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
beforeEach(() => request.mockReset());
afterEach(() => cleanup());

describe('agent plugin credential writing', () => {
  it('writes a secret once, displays its fingerprint, and saves only its reference in agent config', async () => {
    const draft = {
      id: 'agent-1',
      draftVersion: '1',
      config: {
        ...emptyAgentConfig(),
        mode: 'context' as const,
        voice: {
          carrier: { plugin: 'carrier-fixture', config: {} },
          textFilters: [],
          acknowledgements: [],
        },
      },
    };
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/agents/agent-1' && init?.method === 'PUT')
        return { data: { ...draft, config: JSON.parse(String(init.body))?.config } };
      if (path === '/agents/agent-1') return { data: draft };
      if (path === '/plugins')
        return {
          data: {
            plugins: [
              {
                id: 'carrier-fixture',
                version: '1.0.0',
                kind: 'carrier',
                provider: 'fixture',
                available: true,
                secretFields: ['/apiKey'],
                configSchema: { properties: { apiKey: { type: 'object' } } },
              },
            ],
          },
        };
      if (path === '/provider-bindings' || (path === '/credentials' && !init?.method))
        return { data: { items: [] } };
      if (path === '/plugins/compat') return { data: [] };
      if (path === '/credentials' && init?.method === 'POST')
        return {
          data: {
            id: 'credential-1',
            label: 'Fixture carrier apiKey credential',
            provider: 'fixture',
            type: 'carrier',
            environment: 'production',
            fingerprint: 'fp-123',
          },
        };
      return { data: {} };
    });
    render(
      <SessionProvider identity={{ role: 'admin', workspaceId: 'workspace-1' }}>
        <AgentPluginsFeature agentId="agent-1" />
      </SessionProvider>,
    );
    const secret = (await screen.findByLabelText('apiKey')) as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(secret, { target: { value: 'private-key' } });
    fireEvent.blur(secret);
    await waitFor(() => expect(screen.getByText('Stored · fingerprint fp-123')).toBeDefined());
    expect(secret.value).toBe('');
    const credentialWrite = request.mock.calls.find(
      ([path, init]) => path === '/credentials' && init?.method === 'POST',
    );
    expect(JSON.parse(credentialWrite?.[1]?.body)).toMatchObject({
      provider: 'fixture',
      value: 'private-key',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save plugins' }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([path, init]) => path === '/agents/agent-1' && init?.method === 'PUT',
        ),
      ).toBe(true),
    );
    const save = request.mock.calls.find(
      ([path, init]) => path === '/agents/agent-1' && init?.method === 'PUT',
    );
    const saved = JSON.parse(save?.[1]?.body);
    expect(saved.config.voice.carrier.config.apiKey).toEqual({
      credentialRef: { credentialId: 'credential-1' },
    });
    expect(JSON.stringify(saved)).not.toContain('private-key');
  });
});
