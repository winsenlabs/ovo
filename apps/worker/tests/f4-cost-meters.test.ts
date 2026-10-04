import { describe, expect, it } from 'vitest';
import type { UsageMeter } from '@winsendotai/ovo-contracts';
import { providerMeterKey, providerSourceKind } from '../src/cost-policy-support.ts';

describe('v2 worker cost meters', () => {
  it.each([
    ['stt', 'deepgram.streaming-stt.audio_seconds', 'stt'],
    ['tts', 'openai.streaming-tts.characters', 'tts-generation'],
    ['inference', 'openai.inference.input_tokens', 'llm'],
    ['carrier', 'twilio.carrier.call_seconds', 'carrier'],
  ] as const)(
    'maps %s to its configured meter and ledger source',
    (operation, expectedKey, expectedSource) => {
      const meter = {
        provider: expectedKey.split('.')[0]!,
        operation,
        unit: expectedKey.split('.').at(-1)!,
        quantity: '1',
        state: 'reconciled',
        requestId: 'request-1',
        elapsedMs: 0,
      } as UsageMeter;
      expect(providerMeterKey(meter)).toBe(expectedKey);
      expect(providerSourceKind(meter.operation)).toBe(expectedSource);
    },
  );
});
