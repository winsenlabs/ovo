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
});
export type DetectorConfig = z.output<typeof DetectorConfigSchema>;
