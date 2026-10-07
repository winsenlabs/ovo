import { TurnConfigSchema } from '@winsendotai/ovo-contracts';
import { z } from 'zod';

/**
 * The 'commit' strategy (POC parity): once the VAD reports a stop, a short extra silence forces
 * the STT endpoint and the turn ends on the provider's final instead of after a fixed wait.
 */
export const CommitConfigSchema = z
  .object({
    /**
     * Silence after the VAD's stop before the endpoint is forced. The energy VAD already waits
     * its stopMs (200 ms by default) before it reports a stop, so the default commits about
     * 250 ms after the caller goes quiet, as the POC did.
     */
    silenceMs: z.number().int().min(0).max(5000).default(50),
    /**
     * The silence used instead (never shorter than `silenceMs`) once the utterance has run
     * `longUtteranceMs` of VAD speech, or its interim breaks off mid-word ("tell me for-"):
     * sentences are where callers pause to think. The default commits ~450 ms after a long
     * sentence goes quiet; short answers ("haan", "kal") keep `silenceMs`, so Jev and rules
     * turns lose no time.
     */
    longSilenceMs: z.number().int().min(0).max(5000).default(250),
    longUtteranceMs: z.number().int().min(0).max(60000).default(1200),
    /** Shorter VAD speech with no transcript is a click or a breath and is never committed. */
    minSpeechMs: z.number().int().min(0).max(5000).default(180),
    /**
     * Commits anyway once the interim transcript has not changed for this long, so a VAD held
     * open by line noise cannot stall the turn. 0 disables it.
     */
    stallMs: z.number().int().min(0).max(30000).default(1500),
  })
  .strict();
export type CommitConfig = z.output<typeof CommitConfigSchema>;

/**
 * What counts as the caller rather than the room. A transcript alone can be a background talker,
 * a TV or an STT hallucination on line noise; the VAD (level-gated against the caller's own
 * voice) hearing speech at the same time is the evidence. Applies only once the VAD has heard
 * this caller during a transcribed utterance, so a VAD deaf to a quiet line never mutes them.
 */
export const SpeechEvidenceConfigSchema = z
  .object({
    /** A transcript barges in over the agent only with VAD speech behind it. */
    bargeIn: z.boolean().default(true),
    /** A transcript starts a turn in silence only with VAD speech behind it. */
    turns: z.boolean().default(false),
    /**
     * VAD speech the barge-in needs beyond the VAD's own start window (startMs, 200 ms by default,
     * is already a minimum). 0 adds no wait: transcripts land 300 ms or more after the VAD starts.
     */
    minSpeechMs: z.number().int().min(0).max(5000).default(0),
    /** How far back VAD speech still backs a transcript: finals land up to ~1 s after the audio. */
    windowMs: z.number().int().min(0).max(10000).default(1500),
  })
  .strict();
export type SpeechEvidenceConfig = z.output<typeof SpeechEvidenceConfigSchema>;

/**
 * N8: the opening (the agent's first speech, before the caller has had a turn) is protected from a
 * single stray interim: a cough or the STT's first garbled guess must not cut the greeting.
 */
export const OpeningConfigSchema = z
  .object({
    /**
     * Nothing barges in on the opening for this long after it starts. On the call's first line
     * that is when its synthesis starts (no audio has reached the carrier yet to time it by), so
     * the default allows ~300 ms of TTS first byte and carrier delay: ~1.5 s of heard audio.
     * 0 disables.
     */
    protectMs: z.number().int().min(0).max(10000).default(1800),
    /**
     * After that, only confirmed words barge in on it: two transcript revisions that start with
     * the same word. A lone interim the STT then revises away never does.
     */
    confirmWords: z.boolean().default(true),
  })
  .strict();
export type OpeningConfig = z.output<typeof OpeningConfigSchema>;

/**
 * The detector's row config: the shared TurnConfig plus the 'commit' strategy. In 'commit',
 * `userSpeechTimeoutMs` is a ceiling on the wait for the final after the commit, not an extra
 * wait added to it.
 */
export const DetectorConfigSchema = TurnConfigSchema.extend({
  /**
   * auto → commit for an STT that only finalises on a host commit (forceEndpoint without its own
   * end-of-turn); otherwise vad-timeout when a VAD is selected, else provider.
   */
  strategy: z.enum(['auto', 'provider', 'vad-timeout', 'commit']).default('auto'),
  commit: CommitConfigSchema.default(() => CommitConfigSchema.parse({})),
  /**
   * A turn whose text breaks off mid-word ("…tell me for-", "Do you know the…") waits this long
   * for the caller to go on before it ends; speech or new words in the wait continue the same
   * turn. Only such turns pay it. 0 disables it.
   */
  cutoffHoldMs: z.number().int().min(0).max(10000).default(700),
  speechEvidence: SpeechEvidenceConfigSchema.default(() => SpeechEvidenceConfigSchema.parse({})),
  opening: OpeningConfigSchema.default(() => OpeningConfigSchema.parse({})),
});
export type DetectorConfig = z.output<typeof DetectorConfigSchema>;

/**
 * The recommended turn detector row for 8 kHz phone calls with a manual-commit STT (Scribe) and
 * the energy VAD: the defaults, which are tuned for it. Spelled out so an agent's config can be
 * reviewed against it.
 */
export const PHONE_TURN_CONFIG: Readonly<DetectorConfig> = Object.freeze(
  DetectorConfigSchema.parse({
    strategy: 'auto',
    userSpeechTimeoutMs: 600,
    minWordsWhileBotSpeaking: 2,
    backchannelsEnabled: true,
    commit: { silenceMs: 50, longSilenceMs: 250, longUtteranceMs: 1200, minSpeechMs: 180 },
    cutoffHoldMs: 700,
    speechEvidence: { bargeIn: true, turns: false, minSpeechMs: 0, windowMs: 1500 },
    opening: { protectMs: 1800, confirmWords: true },
  }),
);
