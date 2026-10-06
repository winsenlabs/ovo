import { describe, expect, it } from 'vitest';
import type { SpeechToText, SttConfigurationUpdate } from '@winsendotai/ovo-contracts';
import { adaptSpeechToText } from '../src/speech-adapters/stt-format.ts';

const MULAW = { encoding: 'mulaw', sampleRate: 8000, channels: 1 } as const;
const capabilities = {
  inputFormats: [MULAW],
  languages: ['*'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'],
  forceEndpoint: true,
} as const;
const input = {
  sessionId: 's',
  format: MULAW,
  language: 'en-IN',
  signal: new AbortController().signal,
  onEvent: () => undefined,
  onUsage: () => undefined,
};

describe('STT format adapter and live reconfiguration (STT-4)', () => {
  it('forwards updateConfiguration only when the provider session has it', async () => {
    const updates: SttConfigurationUpdate[] = [];
    const session = { write: async () => {}, finish: async () => {}, cancel: async () => {} };
    const reconfigurable: SpeechToText = {
      capabilities,
      start: async () => ({ ...session, updateConfiguration: async (u) => void updates.push(u) }),
    };
    const fixed: SpeechToText = { capabilities, start: async () => session };
    const adapted = await adaptSpeechToText(reconfigurable).start(input);
    await adapted.updateConfiguration!({ endpointing: 'fast' });
    expect(updates).toEqual([{ endpointing: 'fast' }]);
    expect((await adaptSpeechToText(fixed).start(input)).updateConfiguration).toBeUndefined();
    await adapted.finish();
    await expect(adapted.updateConfiguration!({ endpointing: 'patient' })).rejects.toThrow(
      'closed',
    );
  });
});
