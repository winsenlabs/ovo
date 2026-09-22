import { z } from 'zod';

/** A selectable voice slot (§4.1). Text filters are selected as a list, not a slot. */
export const Slot = z.enum([
  'engine',
  'carrier',
  'stt',
  'tts',
  'llm',
  'vad',
  'turnDetector',
  'audioFilter',
]);
export type Slot = z.infer<typeof Slot>;

/** One plugin choice: an installed plugin id, an optional provider binding and the row config. */
export const VoiceSelection = z
  .object({
    plugin: z.string().min(1),
    binding: z.string().optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type VoiceSelection = z.infer<typeof VoiceSelection>;

/** Explicit per-release acknowledgements that relax a compatibility rule or accept a model licence. */
export const Acknowledgement = z.enum([
  'weak-playback-evidence',
  'model-licence:livekit-turn-detector',
  'model-licence:silero',
  'model-licence:smart-turn',
]);
export type Acknowledgement = z.infer<typeof Acknowledgement>;

/** `AgentConfig.voice`. Contracts never name a first-party plugin; defaults come from distribution. */
export const AgentVoice = z
  .object({
    engine: VoiceSelection.optional(),
    carrier: VoiceSelection.optional(),
    stt: VoiceSelection.optional(),
    tts: VoiceSelection.optional(),
    llm: VoiceSelection.optional(),
    vad: VoiceSelection.optional(),
    turnDetector: VoiceSelection.optional(),
    audioFilter: VoiceSelection.optional(),
    textFilters: z.array(VoiceSelection).max(8).default([]),
    acknowledgements: z.array(Acknowledgement).default([]),
  })
  .strict();
export type AgentVoice = z.infer<typeof AgentVoice>;
