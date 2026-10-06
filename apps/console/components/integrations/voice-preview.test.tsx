import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindingsForSlot, ProviderMap } from '../studio/configuration-panels';
import { BindingsTable } from './bindings-table';
import { VoicePreviewButton } from './voice-preview-button';
import { emptyAgentConfig, type ProviderBinding } from '../../lib/api';

const binding = (over: Partial<ProviderBinding>): ProviderBinding => ({
  id: 'b-1',
  label: 'Binding',
  provider: 'openai',
  environment: 'production',
  credentialId: 'cred-1',
  ...over,
});

const played = vi.fn(async () => undefined);
beforeEach(() => {
  played.mockClear();
  vi.stubGlobal(
    'Audio',
    vi.fn(function (this: { play: typeof played; pause: () => void }) {
      this.play = played;
      this.pause = () => undefined;
    }),
  );
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Preview voice (Wave 2 #5)', () => {
  it('renders the binding through the preview route and plays it', async () => {
    const fetch = vi.fn(
      async () => new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetch);
    render(<VoicePreviewButton bindingId="tts 1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview voice' }));
    await waitFor(() => expect(played).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/provider-bindings/tts%201/preview',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });

  it("shows the API's reason when the preview fails", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Only a TTS binding can preview' } }), {
            status: 409,
          }),
      ),
    );
    render(<VoicePreviewButton bindingId="b-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview voice' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Only a TTS binding can preview',
    );
    expect(played).not.toHaveBeenCalled();
  });

  it('is offered on TTS bindings only', () => {
    render(
      <BindingsTable
        bindings={[binding({ id: 'tts', kind: 'tts' }), binding({ id: 'llm', kind: 'llm' })]}
        role="admin"
        busy={false}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Preview voice' })).toHaveLength(1);
  });
});

describe('Studio ProviderMap (Wave 2 #6)', () => {
  const bindings = [
    binding({ id: 'stt', kind: 'stt', label: 'Scribe' }),
    binding({ id: 'tts', kind: 'tts', label: 'Voice' }),
    binding({ id: 'llm', kind: 'llm', label: 'Model' }),
    binding({ id: 'twilio', kind: 'carrier', label: 'Twilio' }),
    binding({ id: 'legacy', kind: null, label: 'Legacy' }),
  ];

  it('offers each slot only bindings of its kind, plus kindless legacy ones', () => {
    const ids = (slot: string, selected?: string) =>
      bindingsForSlot(bindings, slot, selected).map((item) => item.id);
    expect(ids('stt')).toEqual(['stt', 'legacy']);
    expect(ids('tts')).toEqual(['tts', 'legacy']);
    expect(ids('inference')).toEqual(['llm', 'legacy']);
    expect(ids('telephony')).toEqual(['twilio', 'legacy']);
    // A draft that already points a slot at another kind keeps its value visible.
    expect(ids('stt', 'tts')).toEqual(['stt', 'tts', 'legacy']);
  });

  it('renders the filtered options in the slot selects', () => {
    render(
      <ProviderMap
        config={{ ...emptyAgentConfig(), mode: 'agent' }}
        bindings={bindings}
        update={vi.fn()}
      />,
    );
    const tts = screen.getByLabelText('TTS binding');
    const options = [...tts.querySelectorAll('option')].map((option) => option.textContent);
    expect(options).toEqual(['Not bound', 'Voice · production', 'Legacy · production']);
  });
});
