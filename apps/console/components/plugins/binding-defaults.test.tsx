import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BindingSelect } from './binding-select';
import { schemaDefaults } from './schema-defaults';
import { BindingManager } from '../integrations/bindings';
import { ConfirmDialogProvider } from '../ui/dialog';
import type { PluginOption } from './types';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiRequest: request,
}));
beforeEach(() => request.mockReset());
afterEach(() => cleanup());

/** The shape the API's /plugins route returns for the ElevenLabs TTS manifest. */
const elevenLabs: PluginOption = {
  id: '@winsendotai/ovo-tts-elevenlabs',
  version: '0.1.0',
  kind: 'tts',
  provider: 'elevenlabs',
  available: true,
  bindingSchema: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        enum: ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'],
        default: 'eleven_flash_v2_5',
      },
      voiceId: { type: 'string', default: 'ZUrEGyu8GFMwnHbvLhv2' },
      speed: { type: 'number', minimum: 0.7, maximum: 1.2, default: 1 },
      transport: { type: 'string', enum: ['websocket', 'http'], default: 'websocket' },
    },
  },
  ui: {
    label: 'ElevenLabs Text to Speech',
    vendor: 'ElevenLabs',
    fields: { voiceId: { label: 'Voice ID' }, transport: { advanced: true } },
  },
};

describe('binding forms start from the plugin defaults', () => {
  it('takes visible schema defaults and leaves advanced fields to the plugin', () => {
    expect(schemaDefaults(elevenLabs)).toEqual({
      model: 'eleven_flash_v2_5',
      voiceId: 'ZUrEGyu8GFMwnHbvLhv2',
      speed: 1,
    });
  });

  it('opens the ElevenLabs binding drawer on Flash v2.5 and the Monika Sogam voice', async () => {
    request.mockResolvedValue({ data: { id: 'binding-11' } });
    render(
      <BindingSelect
        plugin={elevenLabs}
        bindings={[]}
        credentials={[{ id: 'cred-11', label: 'ElevenLabs key', provider: 'elevenlabs' } as never]}
        onChange={vi.fn()}
      />,
    );
    expect((screen.getByLabelText('model') as HTMLSelectElement).value).toBe('eleven_flash_v2_5');
    expect((screen.getByLabelText('Voice ID') as HTMLInputElement).value).toBe(
      'ZUrEGyu8GFMwnHbvLhv2',
    );
    expect(screen.queryByLabelText('transport')).toBeNull();
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Monika' } });
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'cred-11' } });
    fireEvent.submit(screen.getByLabelText('Label').closest('form')!);
    await waitFor(() => expect(request).toHaveBeenCalled());
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe('/provider-bindings');
    expect(JSON.parse(init.body)).toMatchObject({
      provider: 'elevenlabs',
      pluginId: elevenLabs.id,
      config: { model: 'eleven_flash_v2_5', voiceId: 'ZUrEGyu8GFMwnHbvLhv2', speed: 1 },
    });
  });

  it('fills the integrations binding JSON when ElevenLabs is picked for a new binding', async () => {
    request.mockImplementation(async (path: string) =>
      path === '/plugins' ? { data: { plugins: [elevenLabs] } } : { data: {} },
    );
    render(
      <ConfirmDialogProvider>
        <BindingManager bindings={[]} credentials={[]} reload={vi.fn()} role="admin" />
      </ConfirmDialogProvider>,
    );
    const select = await screen.findByLabelText('Plugin');
    await screen.findByRole('option', { name: 'ElevenLabs Text to Speech' });
    fireEvent.change(select, { target: { value: elevenLabs.id } });
    const config = screen.getByLabelText('Provider configuration JSON') as HTMLTextAreaElement;
    expect(JSON.parse(config.value)).toEqual({
      model: 'eleven_flash_v2_5',
      voiceId: 'ZUrEGyu8GFMwnHbvLhv2',
      speed: 1,
    });
  });
});
