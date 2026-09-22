import { describe, expect, it } from 'vitest';
import {
  Acknowledgement,
  AgentConfig,
  AgentVoice,
  ReleaseSelections,
  Slot,
  VoiceSelection,
  isReleaseSelectionKey,
  type Release,
} from '../src/index.ts';

describe('selection model', () => {
  it('lists the voice slots and acknowledgements exactly', () => {
    expect(Slot.options).toEqual([
      'engine',
      'carrier',
      'stt',
      'tts',
      'llm',
      'vad',
      'turnDetector',
      'audioFilter',
    ]);
    expect(Acknowledgement.options).toEqual([
      'weak-playback-evidence',
      'model-licence:livekit-turn-detector',
      'model-licence:silero',
      'model-licence:smart-turn',
    ]);
  });

  it('fills voice defaults and keeps selections strict', () => {
    expect(AgentVoice.parse({})).toEqual({ textFilters: [], acknowledgements: [] });
    expect(VoiceSelection.parse({ plugin: '@acme/ovo-stt-example' })).toEqual({
      plugin: '@acme/ovo-stt-example',
      config: {},
    });
    expect(() => VoiceSelection.parse({ plugin: 'x', extra: true })).toThrow();
    expect(() => VoiceSelection.parse({ plugin: '' })).toThrow();
    expect(() =>
      AgentVoice.parse({ textFilters: Array.from({ length: 9 }, () => ({ plugin: 'f' })) }),
    ).toThrow();
    expect(() => AgentVoice.parse({ acknowledgements: ['anything-goes'] })).toThrow();
  });

  it('parses a legacy AgentConfig without voice and keeps providers exactly', () => {
    const legacy = AgentConfig.parse({
      name: 'Legacy',
      mode: 'agent',
      providers: { stt: 'binding-stt', tts: 'binding-tts', inference: 'binding-llm' },
    });
    expect(legacy.voice).toBeUndefined();
    expect(legacy.providers).toEqual({
      stt: 'binding-stt',
      tts: 'binding-tts',
      inference: 'binding-llm',
    });
  });

  it('parses an AgentConfig with per-agent voice selections', () => {
    const config = AgentConfig.parse({
      name: 'Voice',
      mode: 'agent',
      voice: {
        engine: { plugin: '@acme/ovo-engine-example', config: { bargeIn: true } },
        carrier: { plugin: '@acme/ovo-carrier-example', binding: 'carrier-binding' },
        textFilters: [{ plugin: '@acme/ovo-text-filter-example' }],
        acknowledgements: ['weak-playback-evidence'],
      },
    });
    expect(config.voice?.engine).toEqual({
      plugin: '@acme/ovo-engine-example',
      config: { bargeIn: true },
    });
    expect(config.voice?.textFilters).toEqual([
      { plugin: '@acme/ovo-text-filter-example', config: {} },
    ]);
    expect(() => AgentConfig.parse({ name: 'x', mode: 'faq', voice: { voice: {} } })).toThrow();
  });

  it('keys release selections by slot, textFilter:N and companion:KEY', () => {
    for (const key of [
      'engine',
      'turnDetector',
      'textFilter:0',
      'textFilter:7',
      'companion:ovo.speech',
    ])
      expect(isReleaseSelectionKey(key), key).toBe(true);
    for (const key of ['voice', 'textFilter:', 'textFilter:x', 'companion:'])
      expect(isReleaseSelectionKey(key), key).toBe(false);
    const selection = { pluginId: '@acme/ovo-stt-example', version: '1.2.0', config: {} };
    const selections = ReleaseSelections.parse({
      stt: {
        ...selection,
        bindingId: 'binding-1',
        binding: {
          provider: 'example',
          config: { model: 'fast' },
          credentialId: 'credential-1',
          fingerprint: 'sha256:abc',
          updatedAt: '2026-09-22T00:00:00.000Z',
        },
      },
      'companion:ovo.speech': selection,
    });
    const release: Release = {
      id: 'release-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      config: AgentConfig.parse({ name: 'x', mode: 'faq' }),
      plugins: [],
      selections,
      createdAt: '2026-09-22T00:00:00.000Z',
    };
    expect(release.selections?.stt?.binding?.credentialId).toBe('credential-1');
    expect(() => ReleaseSelections.parse({ voice: selection })).toThrow();
    expect(() => ReleaseSelections.parse({ stt: { ...selection, version: 'latest' } })).toThrow();
  });
});
