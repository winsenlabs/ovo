import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { SchemaForm } from './plugins/schema-form';
import { CompatSummary } from './plugins/compat-summary';
import { BindingSelect } from './plugins/binding-select';
import { SlotPicker } from './plugins/slot-picker';
import type { CompatIssue } from './plugins/types';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
beforeEach(() => request.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const plugin = {
  id: 'carrier-fixture',
  version: '1.0.0',
  kind: 'carrier',
  provider: 'fixture',
  available: true,
  ui: { label: 'Fixture carrier' },
};
const voice = { textFilters: [], acknowledgements: [] };
const issue = (code: string, slot = 'carrier'): CompatIssue =>
  ({ code, stage: 'release', severity: 'error', slot, message: `${code} message` }) as CompatIssue;

describe('manifest-driven console controls', () => {
  it('shows carrier operator URLs from the selected binding, with copy controls', async () => {
    request.mockResolvedValue({
      data: {
        items: [
          { purpose: 'answer', label: 'Answer URL', url: 'https://fixture.test/answer?t=opaque' },
        ],
      },
    });
    const copy = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copy } });
    render(
      <BindingSelect
        plugin={plugin}
        value="binding-1"
        bindings={[
          {
            id: 'binding-1',
            label: 'Carrier one',
            provider: 'fixture',
            pluginId: 'carrier-fixture',
            credentialId: 'c1',
            environment: 'test',
          },
          {
            id: 'binding-other',
            label: 'Other carrier',
            provider: 'other',
            pluginId: 'other',
            credentialId: 'c2',
            environment: 'test',
          },
        ]}
        credentials={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('option', { name: 'Carrier one' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Other carrier' })).toBeNull();
    await waitFor(() =>
      expect(screen.getByText('https://fixture.test/answer?t=opaque')).toBeDefined(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('https://fixture.test/answer?t=opaque'));
  });

  it('shows no operator URLs for an environment binding', () => {
    render(<BindingSelect plugin={plugin} bindings={[]} credentials={[]} onChange={vi.fn()} />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByText('Operator URLs')).toBeNull();
  });

  it('does not offer a secret field in binding configuration', () => {
    const secretPlugin = {
      ...plugin,
      secretFields: ['/token'],
      bindingSchema: { properties: { token: { type: 'object' } }, required: ['token'] },
    };
    render(
      <BindingSelect
        plugin={secretPlugin}
        bindings={[]}
        credentials={[
          {
            id: 'credential-1',
            label: 'Stored API key',
            provider: 'fixture',
            type: 'api-key',
            environment: 'production',
          },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('token')).toBeNull();
    expect(screen.getByText(/Use the binding credential above/)).toBeDefined();
    expect(
      (
        screen
          .getByLabelText('Credential')
          .closest('form')!
          .querySelector('button[type=submit]') as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('saves a write-only credential before creating a binding and keeps its value out of config', async () => {
    request.mockImplementation(async (path: string) =>
      path === '/credentials'
        ? {
            data: {
              id: 'credential-new',
              label: 'Fixture carrier credential',
              provider: 'fixture',
              type: 'carrier',
              environment: 'production',
              fingerprint: 'fp-123',
            },
          }
        : {
            data: {
              id: 'binding-new',
              label: 'New carrier',
              provider: 'fixture',
              pluginId: plugin.id,
              credentialId: 'credential-new',
              environment: 'production',
            },
          },
    );
    render(<BindingSelect plugin={plugin} bindings={[]} credentials={[]} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'New carrier' } });
    const secret = screen.getByLabelText('New credential value') as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(secret, { target: { value: 'private-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save credential', hidden: true }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/credentials',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"value":"private-key"'),
        }),
      ),
    );
    await waitFor(() => expect(secret.value).toBe(''));
    expect(screen.getByText('Stored · fingerprint fp-123')).toBeDefined();
    fireEvent.submit(secret.closest('form')!);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/provider-bindings',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"credentialId":"credential-new","config":{}'),
        }),
      ),
    );
  });

  it('uses a credential reference for an agent config secret pointer', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        plugin={{ ...plugin, secretFields: ['/apiKey'] }}
        schema={{ properties: { apiKey: { type: 'object' } }, required: ['apiKey'] }}
        value={{}}
        onChange={onChange}
        credentials={[
          {
            id: 'credential-1',
            label: 'Stored API key',
            provider: 'fixture',
            type: 'carrier',
            environment: 'production',
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'credential-1' } });
    expect(onChange).toHaveBeenCalledWith({
      apiKey: { credentialRef: { credentialId: 'credential-1' } },
    });
    expect(screen.queryByLabelText('apiKey', { selector: 'input[type=password]' })).toBeNull();
  });

  it('makes a newly saved binding credential available to the sibling config selector', async () => {
    const secretPlugin = {
      ...plugin,
      secretFields: ['/apiKey'],
      configSchema: { properties: { apiKey: { type: 'object' } } },
    };
    request.mockResolvedValue({
      data: {
        id: 'credential-new',
        label: 'Fixture carrier credential',
        provider: 'fixture',
        type: 'carrier',
        environment: 'production',
        fingerprint: 'fp-123',
      },
    });
    function PluginControls() {
      const [credentials, setCredentials] = useState<
        {
          id: string;
          label: string;
          provider: string;
          type: string;
          environment: string;
          fingerprint?: string;
        }[]
      >([]);
      const [config, setConfig] = useState<Record<string, unknown>>({});
      return (
        <>
          <BindingSelect
            plugin={secretPlugin}
            bindings={[]}
            credentials={credentials}
            onChange={vi.fn()}
            onCredentialCreated={(credential) =>
              setCredentials((current) => [...current, credential])
            }
          />
          <SchemaForm
            plugin={secretPlugin}
            schema={secretPlugin.configSchema}
            value={config}
            onChange={setConfig}
            credentials={credentials}
          />
          <output data-testid="agent-config">{JSON.stringify(config)}</output>
        </>
      );
    }
    render(<PluginControls />);
    const field = screen.getByLabelText('apiKey') as HTMLSelectElement;
    expect(field.options.length).toBe(1);
    fireEvent.change(screen.getByLabelText('New credential value'), {
      target: { value: 'private-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save credential', hidden: true }));
    await waitFor(() => expect(field.options.length).toBe(2));
    expect(field.options[1]?.text).toContain('Fixture carrier credential');
    fireEvent.change(field, { target: { value: 'credential-new' } });
    expect(screen.getByTestId('agent-config').textContent).toBe(
      '{"apiKey":{"credentialRef":{"credentialId":"credential-new"}}}',
    );
  });

  it('clears the draft credential and config when a slot switches plugins', async () => {
    request.mockResolvedValue({
      data: {
        id: 'credential-new',
        label: 'First credential',
        provider: 'fixture',
        type: 'carrier',
        environment: 'production',
        fingerprint: 'fp-123',
      },
    });
    const view = render(
      <BindingSelect
        plugin={{ ...plugin, bindingSchema: { properties: { region: { type: 'string' } } } }}
        bindings={[]}
        credentials={[]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('region'), { target: { value: 'region-A' } });
    fireEvent.change(screen.getByLabelText('New credential value'), {
      target: { value: 'first-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save credential', hidden: true }));
    await waitFor(() =>
      expect((screen.getByLabelText('Credential') as HTMLSelectElement).value).toBe(
        'credential-new',
      ),
    );
    expect(screen.getByText('Stored · fingerprint fp-123')).toBeDefined();
    request.mockClear();

    view.rerender(
      <BindingSelect
        plugin={{
          ...plugin,
          id: 'other-carrier',
          provider: 'other',
          bindingSchema: { properties: { region: { type: 'string' } } },
        }}
        bindings={[]}
        credentials={[]}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByLabelText('Credential') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('region') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Stored · fingerprint fp-123')).toBeNull();
    fireEvent.submit(screen.getByLabelText('Credential').closest('form')!);
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Select or save a credential');
  });

  it('renders enum, bounded number, switch, and advanced disclosure from the schema', () => {
    const onChange = vi.fn();
    render(
      <SchemaForm
        plugin={plugin}
        value={{}}
        onChange={onChange}
        schema={{
          properties: {
            region: { enum: ['in', 'us'] },
            timeout: { type: 'number', minimum: 1, maximum: 10 },
            active: { type: 'boolean' },
          },
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('region'), { target: { value: 'in' } });
    expect(onChange).toHaveBeenCalledWith({ region: 'in' });
    const timeout = screen.getByLabelText('timeout') as HTMLInputElement;
    expect(timeout.min).toBe('1');
    expect(timeout.max).toBe('10');
    fireEvent.change(timeout, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith({ timeout: 7 });
    expect(screen.getByRole('switch')).toBeDefined();
    expect(screen.getByText('Advanced JSON')).toBeDefined();
  });

  it('groups compatibility issues by stage and links back to the slot', () => {
    render(
      <CompatSummary
        issues={[issue('format_unreachable'), issue('binding_missing', 'engine')]}
        voice={voice}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'release · carrier' })).toBeDefined();
    expect(
      screen.getByRole('link', { name: 'format_unreachable message' }).getAttribute('href'),
    ).toBe('#slot-carrier');
    expect(screen.getByRole('link', { name: 'binding_missing message' }).getAttribute('href')).toBe(
      '#slot-engine',
    );
  });

  it('only presents weak playback acknowledgement for the matching issue', () => {
    const change = vi.fn();
    const view = render(
      <CompatSummary issues={[issue('format_unreachable')]} voice={voice} onChange={change} />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    view.rerender(
      <CompatSummary
        issues={[issue('playback_evidence_insufficient')]}
        voice={voice}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(change).toHaveBeenCalledWith({ ...voice, acknowledgements: ['weak-playback-evidence'] });
  });

  it('hides the LLM slot for announcement and FAQ modes', () => {
    const view = render(
      <SlotPicker
        slot="llm"
        plugins={[{ id: 'llm-fixture', version: '1', kind: 'llm', available: true }]}
        voice={voice}
        mode="announcement"
        language="en-IN"
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('group')).toBeNull();
    view.rerender(
      <SlotPicker
        slot="llm"
        plugins={[{ id: 'llm-fixture', version: '1', kind: 'llm', available: true }]}
        voice={voice}
        mode="faq"
        language="en-IN"
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('group')).toBeNull();
  });
});
