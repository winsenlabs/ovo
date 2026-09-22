import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CAPACITY_METRIC_NAMES,
  DEFAULT_VAD_PARAMS,
  MULAW_8K,
  PCM16_16K,
  PCM16_24K,
  PCM16_8K,
  SESSION_INPUT_JSON_SCHEMA,
  TurnConfigSchema,
  bytesPerSecond,
  defaultMuteRules,
  meterKey,
  sameFormat,
  type Behavior,
  type BehaviorEvent,
  type Inference,
  type SessionInput,
  type SpeechKindV2,
  type SpeechOutput,
  type SpeechReceipt,
  type SynthesisInput,
  type TurnConfig,
  type TurnDetectorFactory,
  type UsageMeter,
} from '../src/index.ts';

describe('audio and usage', () => {
  it('computes bytes per second and compares formats', () => {
    expect(bytesPerSecond(MULAW_8K)).toBe(8000);
    expect(bytesPerSecond(PCM16_8K)).toBe(16000);
    expect(bytesPerSecond(PCM16_16K)).toBe(32000);
    expect(bytesPerSecond(PCM16_24K)).toBe(48000);
    expect(sameFormat(MULAW_8K, { encoding: 'mulaw', sampleRate: 8000, channels: 1 })).toBe(true);
    expect(sameFormat(MULAW_8K, PCM16_8K)).toBe(false);
  });

  it('reproduces the v1 meter keys from cost-runtime.ts', () => {
    expect(meterKey({ provider: 'deepgram', operation: 'stt', unit: 'audio_seconds' })).toBe(
      'deepgram.streaming-stt.audio_seconds',
    );
    expect(meterKey({ provider: 'openai', operation: 'tts', unit: 'characters' })).toBe(
      'openai.streaming-tts.characters',
    );
    expect(meterKey({ provider: 'twilio', operation: 'carrier', unit: 'audio_seconds' })).toBe(
      'twilio.carrier.audio_seconds',
    );
    for (const unit of [
      'input_tokens',
      'uncached_input_tokens',
      'cache_read_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
    ] as const)
      expect(meterKey({ provider: 'openai', operation: 'inference', unit })).toBe(
        `openai.inference.${unit}`,
      );
    expect(
      meterKey({ provider: 'openai', operation: 'stt', unit: 'audio_seconds' }, 'batch-stt'),
    ).toBe('openai.batch-stt.audio_seconds');
    expectTypeOf<UsageMeter['requestId']>().toEqualTypeOf<string>();
  });

  it('names the capacity metrics', () => {
    expect(CAPACITY_METRIC_NAMES).toEqual({
      namespace: 'OVO/Capacity',
      required: 'RequiredSlots',
      provisioned: 'ProvisionedTasks',
      busy: 'BusySlots',
      readyIdle: 'ReadyIdleSlots',
      eligible: 'EligibleJobs',
      campaign: 'CampaignDemand',
      oldestAge: 'OldestEligibleJobAgeSeconds',
    });
  });
});

describe('turn detection', () => {
  it('fills exactly the §2.7 defaults from an empty config', () => {
    const config: TurnConfig = TurnConfigSchema.parse({});
    expect(config).toEqual({
      strategy: 'auto',
      userSpeechTimeoutMs: 600,
      stopTimeoutMs: 5000,
      waitForTranscript: true,
      minWordsWhileBotSpeaking: 2,
      backchannels: [
        'uh huh',
        'mm hmm',
        'yeah',
        'yes',
        'ok',
        'okay',
        'right',
        'haan',
        'achha',
        'hmm',
      ],
      mute: [],
      allowDtmfWhileMuted: true,
      idle: { timeoutMs: 10000, maxRetries: 1, prompts: ['Are you still there?'] },
      dtmf: { interDigitMs: 2000, terminator: '#', maxDigits: 32, interruptOnFirstDigit: true },
    });
    expect(TurnConfigSchema.parse({ idle: null }).idle).toBeNull();
    const first = TurnConfigSchema.parse({});
    first.backchannels.push('mutated');
    expect(TurnConfigSchema.parse({}).backchannels).not.toContain('mutated');
    expect(() => TurnConfigSchema.parse({ unknown: true })).toThrow();
  });

  it('maps modes to default mute rules', () => {
    expect(defaultMuteRules('announcement')).toEqual(['always-while-speaking']);
    expect(defaultMuteRules('faq')).toEqual(['during-confirmation']);
    expect(defaultMuteRules('context')).toEqual(['during-confirmation']);
    expect(defaultMuteRules('agent')).toEqual(['during-tools', 'during-confirmation']);
    defaultMuteRules('agent').push('first-speech');
    expect(defaultMuteRules('agent')).toEqual(['during-tools', 'during-confirmation']);
  });

  it('carries the VAD defaults', () => {
    expect(DEFAULT_VAD_PARAMS).toEqual({
      confidence: 0.7,
      startMs: 200,
      stopMs: 200,
      minVolume: 0.6,
      smoothing: 0.2,
    });
  });

  it('types the factory input with mode and overrides', () => {
    type Input = Parameters<TurnDetectorFactory['create']>[0];
    expectTypeOf<Input['mode']>().toEqualTypeOf<SessionInput['mode']>();
    expectTypeOf<Input['overrides']>().toEqualTypeOf<Partial<TurnConfig> | undefined>();
  });
});

describe('engine-facing ports', () => {
  it('describes SessionInput as a strict draft-07 schema', () => {
    expect(SESSION_INPUT_JSON_SCHEMA).toMatchObject({
      type: 'object',
      required: [
        'mode',
        'language',
        'inputEnabled',
        'variables',
        'maxCallSeconds',
        'acknowledgements',
      ],
      additionalProperties: false,
    });
    expect(Object.keys(SESSION_INPUT_JSON_SCHEMA.properties as object)).toContain('initialInput');
    expect(Object.isFrozen(SESSION_INPUT_JSON_SCHEMA)).toBe(true);
    expectTypeOf<SessionInput['mode']>().toEqualTypeOf<
      'announcement' | 'faq' | 'context' | 'agent'
    >();
  });

  it('adds the optional behavior, output, speech and inference members', () => {
    expectTypeOf<Behavior['speechKind']>().toEqualTypeOf<
      ((text: string) => SpeechKindV2 | undefined) | undefined
    >();
    expectTypeOf<NonNullable<Behavior['subscribe']>>()
      .parameter(0)
      .toEqualTypeOf<(event: BehaviorEvent) => void>();
    expectTypeOf<SpeechOutput['prepare']>().not.toBeUndefined();
    expectTypeOf<SpeechReceipt['evidenceSource']>().toEqualTypeOf<
      'carrier-played' | 'carrier-processed' | 'none' | undefined
    >();
    expectTypeOf<Inference['provider']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SynthesisInput['kind']>().toEqualTypeOf<SpeechKindV2 | undefined>();
    const resolved: BehaviorEvent = {
      type: 'confirmation.resolved',
      toolId: 'book',
      operationId: 'op-1',
      result: 'expired',
    };
    expect(resolved.result).toBe('expired');
  });
});
