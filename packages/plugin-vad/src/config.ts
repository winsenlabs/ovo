import { VadParamsSchema, type VadParams } from '@winsendotai/ovo-contracts';
import { z } from 'zod';

/**
 * The energy VAD's row config: the shared VAD params plus its own phone-audio defences. The
 * factory still reports only the shared params, so hosts and the VAD kit see the §2.7 shape.
 */
export const EnergyVadConfigSchema = VadParamsSchema.extend({
  /**
   * Analysis high-pass corner in Hz (24 dB/octave). Handling rumble, phone vibration thumps and
   * mains hum below it never count as speech; telephone speech starts at 300 Hz. Only the VAD's
   * copy is filtered; the STT hears the carrier audio. 0 disables it.
   */
  highPassHz: z.number().min(0).max(1000).default(200),
  /**
   * How slowly the noise floor rises while the caller is confidently speaking. At 2000 ms (the old
   * behaviour) a long utterance raised the floor into its own level and the VAD reported a stop
   * mid-sentence; the default keeps the floor where the pauses put it.
   */
  speechFloorTauMs: z.number().int().min(100).max(120000).default(15000),
  /**
   * Steady tones (beeps, DTMF, ring-back, a vibrating phone's buzz) never start speech. Inside an
   * utterance only a tone lasting 1.5 s ends it, so a held vowel or a "mmm" cannot.
   */
  rejectTones: z.boolean().default(true),
  /**
   * Once a second of the caller's speech is learned, sound this many dB below the caller's own
   * RMS level is a far-field talker, a TV or the room: it does not start speech, does not freeze
   * the noise floor and does not hold an utterance open, though it never cuts one short. At 12 a
   * talker 8 dB or more below the caller is ignored and the caller's own reply up to ~8 dB softer
   * than before still starts. null disables it.
   */
  callerGateDb: z.number().min(6).max(60).nullable().default(12),
}).strict();
export type EnergyVadConfig = z.output<typeof EnergyVadConfigSchema>;

/**
 * The recommended row for 8 kHz phone calls (Twilio μ-law from mobiles): the defaults, which are
 * tuned for it. Spelled out so an agent's config can be reviewed against it.
 */
export const PHONE_VAD_CONFIG: Readonly<EnergyVadConfig> = Object.freeze(
  EnergyVadConfigSchema.parse({
    highPassHz: 200,
    speechFloorTauMs: 15000,
    rejectTones: true,
    callerGateDb: 12,
  }),
);

/** The shared §2.7 params of a row, which is all a host may see. */
export function sharedParams(config: EnergyVadConfig): VadParams {
  const { confidence, startMs, stopMs, minVolume, smoothing } = config;
  return { confidence, startMs, stopMs, minVolume, smoothing };
}
