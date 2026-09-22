import type { Manifest, ManifestV2Input, SpeechCapabilities } from '@winsendotai/ovo-contracts';
import { definePlugin, type PluginDefinition } from '../src/index.ts';

type Apply = PluginDefinition['apply'];

/** A v1 plugin (warn mode unless the composition says otherwise). */
export function v1Plugin(
  id: string,
  provides: string[],
  requires: string[] = [],
  apply: Apply = () => undefined,
  extra: { scope?: 'process' | 'session'; secretFields?: string[]; configSchema?: object } = {},
): PluginDefinition {
  return definePlugin(
    {
      id,
      version: '1.0.0',
      contractVersion: 1,
      scope: extra.scope ?? 'session',
      provides,
      requires,
      configSchema: (extra.configSchema as Record<string, unknown>) ?? { type: 'object' },
      secretFields: extra.secretFields ?? [],
    },
    apply,
  );
}

/** A v2 manifest of kind 'infra' unless overridden (v2 always enforces). */
export function v2Manifest(overrides: Partial<ManifestV2Input> & { id: string }): ManifestV2Input {
  return {
    version: '1.0.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'infra',
    provides: [],
    ...overrides,
  };
}

export function v2Plugin(
  overrides: Partial<ManifestV2Input> & { id: string },
  apply: Apply = () => undefined,
): PluginDefinition {
  // The runtime parses (and defaults) the input; the cast only selects the plain-string overload.
  return definePlugin(v2Manifest(overrides) as Manifest, apply);
}

export const SPEECH: SpeechCapabilities = {
  languages: ['*'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: false,
};

/** A valid v2 engine manifest (no meters needed for engines). */
export function engineManifest(overrides: Partial<ManifestV2Input> & { id: string }) {
  return v2Manifest({
    kind: 'engine',
    provider: 'fixture-engine',
    provides: ['ovo.voice-session-engine@2'],
    capabilities: {
      turnDetection: ['provider'],
      bargeIn: true,
      dtmf: true,
      confirmedPlayback: true,
      ownsProviders: false,
      formats: [],
      consumesTurnDetector: false,
    },
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['engine@1'],
    ...overrides,
  });
}

/** A valid v2 STT manifest. */
export function sttManifest(overrides: Partial<ManifestV2Input> & { id: string }) {
  return v2Manifest({
    kind: 'stt',
    provider: 'fixture-stt',
    provides: ['ovo.stt@2'],
    capabilities: SPEECH,
    meters: [
      {
        key: 'fixture-stt.streaming-stt.audio_seconds',
        unit: 'audio_seconds',
        label: 'Audio',
        role: 'stt',
      },
    ],
    runtime: { egressHosts: ['stt.example.test'], modelLicences: [] },
    conformance: ['stt@1'],
    ...overrides,
  });
}
