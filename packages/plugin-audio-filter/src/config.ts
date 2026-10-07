import { z } from 'zod';

/** The phone-line clean-up applied to the caller's audio before the VAD and the STT hear it. */
export const AudioFilterConfigSchema = z
  .object({
    /**
     * High-pass corner in Hz (4th-order Butterworth, 24 dB/octave): handling rumble, a phone
     * vibrating on a table and wind thumps live below it, telephone speech above 300 Hz. At the
     * default, 50 Hz loses 24 dB and 200 Hz under 0.3 dB. 0 disables it.
     */
    highPassHz: z.number().min(0).max(400).default(100),
    /**
     * Narrow notches on mains hum and its harmonics (India and Europe 50 Hz, the Americas 60 Hz),
     * each `mainsHz / q` wide. null disables them.
     */
    hum: z
      .object({
        mainsHz: z.union([z.literal(50), z.literal(60)]).default(50),
        harmonics: z.number().int().min(1).max(8).default(4),
        q: z.number().min(5).max(100).default(30),
      })
      .strict()
      .nullable()
      .default(() => ({ mainsHz: 50 as const, harmonics: 4, q: 30 })),
    /**
     * A downward expander for steady background noise between words: sound within `thresholdDb`
     * of the noise floor is turned down by `rangeDb`, held open `holdMs` after speech. Off by
     * default: STT models are trained on noisy phone audio, so turn it on per agent for noisy
     * callers and compare transcripts first. null disables it.
     */
    gate: z
      .object({
        thresholdDb: z.number().min(3).max(30).default(10),
        rangeDb: z.number().min(3).max(40).default(12),
        holdMs: z.number().int().min(0).max(2000).default(200),
        releaseMs: z.number().int().min(10).max(2000).default(150),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type AudioFilterConfig = z.output<typeof AudioFilterConfigSchema>;

/** The recommended row for 8 kHz phone calls from India: the defaults. */
export const PHONE_AUDIO_FILTER_CONFIG: Readonly<AudioFilterConfig> = Object.freeze(
  AudioFilterConfigSchema.parse({
    highPassHz: 100,
    hum: { mainsHz: 50, harmonics: 4 },
    gate: null,
  }),
);
