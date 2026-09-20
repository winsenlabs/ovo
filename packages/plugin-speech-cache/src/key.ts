import { createHash } from 'node:crypto';
import type { SpeechSynthesisBinding } from './types.ts';

/** Returns an opaque digest; raw text and the compound key never enter telemetry. */
export function createSpeechCacheKey(binding: SpeechSynthesisBinding, text: string): string {
  const identity = [
    'speech-audio-v1',
    binding.workspaceId,
    binding.provider,
    binding.bindingVersion,
    binding.model,
    binding.voice,
    binding.locale,
    binding.codec,
    binding.sampleRate,
    binding.pronunciation,
    binding.prosodyRevision,
    binding.optionsRevision,
    text,
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
