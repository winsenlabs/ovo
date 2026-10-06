import type { AssemblyAiBinding } from './provider.ts';

export const ENDPOINTING_PRESETS = ['fast', 'balanced', 'patient'] as const;
export type EndpointingPreset = (typeof ENDPOINTING_PRESETS)[number];
export type TurnDetection = Required<
  Pick<AssemblyAiBinding, 'endOfTurnConfidenceThreshold' | 'minTurnSilenceMs' | 'maxTurnSilenceMs'>
>;

/**
 * The provider's quick-start configurations, which it names aggressive, balanced and
 * conservative: https://assemblyai.com/docs/streaming/universal-streaming/turn-detection
 * (retrieved 2026-10-06).
 */
const PRESETS: Readonly<Record<EndpointingPreset, TurnDetection>> = Object.freeze({
  fast: { endOfTurnConfidenceThreshold: 0.4, minTurnSilenceMs: 160, maxTurnSilenceMs: 400 },
  balanced: { endOfTurnConfidenceThreshold: 0.4, minTurnSilenceMs: 400, maxTurnSilenceMs: 1280 },
  patient: { endOfTurnConfidenceThreshold: 0.7, minTurnSilenceMs: 800, maxTurnSilenceMs: 3600 },
});

/** The turn-detection values a binding sends: its preset's, with explicit fields on top. */
export function assemblyAiTurnDetection(
  binding: Pick<AssemblyAiBinding, 'endpointing' | keyof TurnDetection>,
): Partial<TurnDetection> {
  const explicit = defined({
    endOfTurnConfidenceThreshold: binding.endOfTurnConfidenceThreshold,
    minTurnSilenceMs: binding.minTurnSilenceMs,
    maxTurnSilenceMs: binding.maxTurnSilenceMs,
  });
  return { ...(binding.endpointing ? PRESETS[binding.endpointing] : {}), ...explicit };
}

function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** A mid-call change of endpointing or prompting, sent as UpdateConfiguration. */
export type AssemblyAiConfigurationUpdate = Pick<
  AssemblyAiBinding,
  'endpointing' | keyof TurnDetection | 'vadThreshold' | 'keyterms' | 'prompt'
>;

/**
 * UpdateConfiguration is a delta: omitted fields keep their current values.
 * https://www.assemblyai.com/docs/streaming/updating-configuration-mid-stream (retrieved 2026-10-06).
 */
export function updateConfigurationMessage(update: AssemblyAiConfigurationUpdate): string {
  const turns = assemblyAiTurnDetection(update);
  return JSON.stringify({
    type: 'UpdateConfiguration',
    ...defined({
      min_turn_silence: turns.minTurnSilenceMs,
      max_turn_silence: turns.maxTurnSilenceMs,
      end_of_turn_confidence_threshold: turns.endOfTurnConfidenceThreshold,
      vad_threshold: update.vadThreshold,
      keyterms_prompt: update.keyterms,
      prompt: update.prompt,
    }),
  });
}
