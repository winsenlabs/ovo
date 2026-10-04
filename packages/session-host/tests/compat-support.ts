import {
  AgentConfig,
  Cap,
  type AudioFormat,
  type ReleaseSelections,
} from '@winsendotai/ovo-contracts';
import { definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { validateSelections, type CompatInput } from '../src/compat/index.ts';

export const MULAW: AudioFormat = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
const PCM: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };
export const UNREACHABLE: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 22050, channels: 1 };
export const speech = {
  languages: ['en-IN'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: false,
};
export const carrier = {
  carrierId: 'fixture',
  media: {
    formats: [MULAW],
    playbackEvidence: 'carrier-played',
    clear: true,
    clearFlushesMarkers: true,
    dtmf: true,
    queryOnMediaUrl: false,
  },
  control: {
    callIdTiming: 'at-dial',
    streamParams: 'at-dial',
    streamCallIdMatchesDial: true,
    cancelBeforeAnswer: true,
    handoff: [],
    amd: 'async',
    maxDuration: true,
    reconcile: 'by-call-id',
    hangup: 'rest',
  },
  continuation: 'none',
  webhookAuth: 'hmac-signature',
  pacing: { cps: 1 },
};
const engine = {
  turnDetection: ['provider'],
  bargeIn: true,
  dtmf: true,
  confirmedPlayback: true,
  ownsProviders: false,
  formats: [MULAW],
  consumesTurnDetector: false,
};
export const data = {
  engine: {
    kind: 'engine',
    provider: 'engine',
    provides: [Cap.engine],
    capabilities: engine,
    conformance: ['engine@1'],
  },
  carrier: {
    kind: 'carrier',
    provider: 'carrier',
    provides: [Cap.carrierControl],
    capabilities: carrier,
    conformance: ['carrier@1'],
  },
  stt: {
    kind: 'stt',
    provider: 'stt',
    provides: [Cap.stt],
    capabilities: { ...speech, inputFormats: [MULAW] },
    conformance: ['stt@1'],
  },
  tts: {
    kind: 'tts',
    provider: 'tts',
    provides: [Cap.tts],
    capabilities: { ...speech, outputFormats: [PCM] },
    conformance: ['tts@1'],
  },
  llm: {
    kind: 'llm',
    provider: 'llm',
    provides: [Cap.inference],
    capabilities: { tools: true, streaming: true },
    conformance: ['llm@1'],
  },
} as const;
export function catalog(change: Record<string, Record<string, unknown>> = {}) {
  return Object.entries(data).map(([id, row]) =>
    definePlugin(
      {
        id,
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        ...row,
        meters:
          id === 'engine'
            ? undefined
            : [{ key: `${id}.usage`, unit: 'audio_seconds', label: 'Usage', role: id }],
        runtime: { egressHosts: [], modelLicences: [] },
        bindingSchema: {
          type: 'object',
          properties: { model: { type: 'string' } },
          required: ['model'],
        },
        ...change[id],
      } as never,
      () => undefined,
    ),
  );
}
export function fixture(change: Record<string, Record<string, unknown>> = {}): CompatInput {
  const definitions = catalog(change);
  const snapshot = (id: string) => ({
    provider: id,
    config: { model: 'ok' },
    credentialId: 'credential',
    fingerprint: 'fingerprint',
    updatedAt: 'today',
  });
  const selections = Object.fromEntries(
    Object.keys(data).map((id) => [
      id,
      {
        pluginId: id,
        version: '1.0.0',
        ...(id === 'engine' ? {} : { bindingId: id, binding: snapshot(id) }),
        config: {},
      },
    ]),
  ) as ReleaseSelections;
  return {
    config: AgentConfig.parse({ name: 'fixture', mode: 'context', language: 'en-IN' }),
    selections,
    registry: new PluginRegistry(definitions),
    carrierFrameMs: 100,
    turnStrategy: 'provider',
    amd: false,
    glibc: true,
    acceptedLicences: [],
    priceCards: { 'carrier.usage': {}, 'stt.usage': {}, 'tts.usage': {}, 'llm.usage': {} },
    fixturePluginIds: ['carrier', 'stt', 'tts', 'llm'],
  };
}
export function withConfig(input: CompatInput, raw: Record<string, unknown>) {
  input.config = AgentConfig.parse({ ...input.config, ...raw });
  return input;
}
export function codes(input: CompatInput, stage: 'release' | 'live' | 'test') {
  return validateSelections(input, stage).map((entry) => entry.code);
}
