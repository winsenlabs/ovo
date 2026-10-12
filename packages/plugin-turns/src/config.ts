import { TurnConfigSchema } from '@winsendotai/ovo-contracts';
import { z } from 'zod';

/**
 * The 'commit' strategy (POC parity): once the VAD reports a stop, a short extra silence forces
 * the STT endpoint and the turn ends on the provider's final instead of after a fixed wait.
 */
export const CommitConfigSchema = z
  .object({
    /**
     * Silence after the VAD's stop before the endpoint is forced, for words whose end gives no
     * signal either way. The energy VAD already waits its stopMs (200 ms by default) before it
     * reports a stop, so the default commits about 250 ms after the caller goes quiet, as the POC
     * did. Wave 8: complete words use `completeSilenceMs` instead, so an agent no longer needs a
     * higher value here to keep sentences whole; 50 (the default) is the recommended value.
     */
    silenceMs: z.number().int().min(0).max(5000).default(50),
    /**
     * Wave 8: the silence for words that read complete (a closing full stop or question mark, a
     * short answer such as "haan" or "Hello", or three words or fewer after the agent asked
     * something), used even when `silenceMs` is set higher: the end of the turn is not in doubt.
     */
    completeSilenceMs: z.number().int().min(0).max(5000).default(50),
    /**
     * The silence used instead (never shorter than `silenceMs`) when the words trail off ("and",
     * "to the", a comma, "for-", "around the 1"), or once an utterance whose end gives no signal
     * has run `longUtteranceMs` of VAD speech: that is where callers pause to think. The default
     * commits ~450 ms after such a sentence goes quiet. Complete words never wait it, however long.
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
    /**
     * Wave 8: the stall for an answer that ends a turn by itself ("Yes.", "हाँ।", "Hello?", "No",
     * "15", a backchannel) while no VAD speech is going on: a word too short or soft to start the
     * VAD. It commits this soon after its interim instead of after `stallMs` (live one-word
     * endpoints of 1.79–1.89 s were the 1.5 s stall plus the final). Any other words keep
     * `stallMs`, short or not ("My name is", "Two adults"), and so do words said while a VAD run is
     * open, even one the room holds: Scribe's interims change about once a second, so a shorter
     * stall would cut a caller still talking. 0 uses `stallMs`.
     */
    answerStallMs: z.number().int().min(0).max(30000).default(250),
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
    /**
     * Wave 9 (call 10d5ef30, D2): words heard no later than this after the agent's reply starts
     * to play are the caller's even with no VAD speech behind them. The caller began them before
     * hearing the reply (an interim lands 0.3–1 s after its first word), so they are no background
     * talk heard over it; the turn waits for the agent to stop and is answered then (`agent`).
     * Live, "Tell me the name." (its first interim 87 ms into the reply) was dropped for the room.
     * 0 turns it off.
     */
    replyStartMs: z.number().int().min(0).max(5000).default(1000),
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
   * A turn whose text trails off ("…tell me for-", "Do you know the…", "Paris, Rome,", "…and",
   * "around the 1") waits this long for the caller to go on before it ends; speech or new words in
   * the wait continue the same turn. Only such turns pay it. 0 disables it.
   */
  cutoffHoldMs: z.number().int().min(0).max(10000).default(700),
  /**
   * Wave 9: the hold instead for words that stop mid-thought, on a hesitation, an article or a
   * preposition ("No, umm...", "…it should still be a", contracts `pausesMidThought`): the caller
   * is thinking, not done. In call 10d5ef30 three such turns ended and the caller went on 0.01–1.6
   * s later; each got a reply made for half a sentence (two asked the caller to say it again), held
   * and thrown away unheard, the last by 0.4 s. The reply's own hold after a turn that trailed off
   * (the engine's 2 s) does not follow it. 0 uses cutoffHoldMs; cutoffHoldMs 0 turns both off.
   */
  pauseHoldMs: z.number().int().min(0).max(10000).default(2500),
  /**
   * Wave 8: a VAD run that brings no new words from the STT for this long (from its start or the
   * last words, whichever is later) is the room, not the caller (café babble the VAD cannot tell
   * from speech): it no longer holds a turn with words open. On the live calls the first words
   * came up to 1.76 s after a turn started and Scribe's interims changed at most 2 s apart, so the
   * default leaves a margin. 0 disables it.
   */
  noiseMs: z.number().int().min(0).max(30000).default(2500),
  /**
   * Wave 8: a short reply said over the agent answers its question (AGT-9) only when the agent
   * stops within this long of it. Said earlier, it came before the question was heard and only
   * acknowledged what the agent was saying then, as it would over a line with no question. A
   * question is one sentence; 6 s allows one of ~18 words. 0 always waits for the agent.
   */
  questionReplyMs: z.number().int().min(0).max(60000).default(6000),
  speechEvidence: SpeechEvidenceConfigSchema.default(() => SpeechEvidenceConfigSchema.parse({})),
  opening: OpeningConfigSchema.default(() => OpeningConfigSchema.parse({})),
  /**
   * N4: the agent's allowed languages (base codes), filled in by the session host from the
   * agent's `languages`. Words mostly outside them never barge in, and over the agent they are no
   * turn at all. Absent, every transcript counts.
   */
  languages: z
    .array(z.string().regex(/^[a-z]{2,3}$/))
    .min(1)
    .max(12)
    .optional(),
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
    commit: {
      silenceMs: 50,
      completeSilenceMs: 50,
      longSilenceMs: 250,
      longUtteranceMs: 1200,
      minSpeechMs: 180,
      stallMs: 1500,
      answerStallMs: 250,
    },
    noiseMs: 2500,
    questionReplyMs: 6000,
    cutoffHoldMs: 700,
    pauseHoldMs: 2500,
    speechEvidence: {
      bargeIn: true,
      turns: false,
      minSpeechMs: 0,
      windowMs: 1500,
      replyStartMs: 1000,
    },
    opening: { protectMs: 1800, confirmWords: true },
  }),
);
