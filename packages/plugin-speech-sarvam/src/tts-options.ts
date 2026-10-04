import type { SarvamTtsBinding } from './tts.ts';

export function sarvamSpeaker(binding: Readonly<SarvamTtsBinding>, voice?: string): string {
  return voice ?? binding.speaker ?? (binding.model === 'bulbul:v2' ? 'anushka' : 'shubh');
}

export function sarvamTextLimit(binding: Readonly<SarvamTtsBinding>): number {
  return binding.model === 'bulbul:v2' ? 1500 : 2500;
}
