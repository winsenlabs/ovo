import { z } from 'zod';
import type { Mode } from '../agent.ts';
import type { Clock } from '../clock.ts';
import type { SpeechCapabilities } from '../speech/capabilities.ts';
import type { SttEvent } from '../speech/stt.ts';
import { countWords, normalizeForMatch } from '../text.ts';
import type { SpeechKindV2 } from './evidence.ts';

export * from './turn-speculation.ts';

export type VoiceEvent =
  | { type: 'stt'; event: SttEvent; atMs: number }
  | { type: 'vad.start' | 'vad.stop'; atMs: number }
  | { type: 'dtmf'; digit: string; atMs: number }
  | {
      type: 'bot.started' | 'bot.stopped';
      epoch: number;
      atMs: number;
      kind?: SpeechKindV2;
      /**
       * bot.started only: a line of this speaking interval asks the caller something, so a short
       * reply said over it ("haan", "yes") is an answer, held until the agent stops, rather than a
       * backchannel (AGT-9). The engine announces bot.started again for the same epoch when a later
       * line turns the interval into a question.
       */
      question?: boolean;
      /**
       * bot.started only: every line of the interval so far is a LAT-6 filler, which answers
       * nothing. The caller's words over it count as in silence: only a listed backchannel ("ok",
       * "haan") acknowledges it, and a short continuation ("Tejas", "tomorrow") is a turn. The
       * engine announces bot.started again, without it, when the reply's own line joins.
       */
      filler?: boolean;
    }
  | { type: 'tool.started' | 'tool.settled'; atMs: number }
  | { type: 'confirmation.pending' | 'confirmation.resolved'; atMs: number };

export type TurnDecision =
  | { type: 'interrupt'; reason: 'vad' | 'transcript' | 'dtmf' }
  | { type: 'turn.started'; turnId: string }
  /**
   * The caller's utterance so far, on every revision while the turn is open and could be answered
   * (never for speech the agent is ignoring as a backchannel or while muted). For speculation (LAT-4).
   */
  | { type: 'turn.partial'; turnId: string; text: string; stable: boolean }
  | {
      type: 'turn.stopped';
      turnId: string;
      input: { kind: 'speech'; text: string; segments: number } | { kind: 'dtmf'; digits: string };
      /** LAT-6: the cached line to play if the reply has no audio `afterMs` into its turn. */
      filler?: { text: string; afterMs: number };
    }
  | { type: 'turn.reset'; turnId: string; reason: 'backchannel' | 'muted' }
  | { type: 'force-endpoint' }
  | { type: 'idle'; retry: number; final: boolean; prompt?: string };

export interface UserTurnController {
  observe(event: VoiceEvent): void;
  on(fn: (decision: TurnDecision) => void): () => void;
  dispose(): void;
}

export const MUTE_RULES = [
  'first-speech',
  'until-first-complete',
  'during-tools',
  'always-while-speaking',
  'during-confirmation',
] as const;
export type MuteRule = (typeof MUTE_RULES)[number];

/** What callers say to acknowledge the agent, as STT writes it: English, then Hindi and Hinglish. */
const BACKCHANNELS = [
  'uh huh|mm hmm|yeah|yes|ok|okay|right|haan|achha|hmm',
  // AGT-9 additions.
  'mhm|hm|yep|sure|alright|got it|i see',
  'han|haa|haan ji|haanji|ji|ji haan|acha|accha|achcha|theek hai|thik hai|theek|thik|sahi|bilkul',
  'हाँ|हां|हाँ जी|हां जी|जी|जी हाँ|अच्छा|ठीक है|हम्म|ओके|बिल्कुल',
  // Wave 6, from live Indian calls: listening sounds and plain acknowledgements, Hinglish, then
  // Devanagari, then Tamil, Telugu and Kannada. Runs ("achha ji", "ok ok") need no entry.
  'mm|mmm|hmmm|mhmm|uh|um|correct|exactly|fine|noted|understood|all right|go on|go ahead|carry on',
  'ha|hanji|samjha|samajh gaya|samajh gayi|boliye|bolo',
  'हम|हाँजी|हांजी|सही|सही है|बोलिए|समझ गया|समझ गई',
  'sari|seri|aama|aamaa|சரி|ஆமா|ஆமாம்|avunu|sare|houdu',
].flatMap((group) => group.split('|'));
/**
 * Forms of address that ride on an acknowledgement ("ok sir", "yes madam", "ji sir"). Alone they
 * acknowledge nothing: "madam, madam" over the agent is the caller asking to be heard.
 */
const HONORIFICS = ['sir', 'madam', 'maam', 'ma am', 'mam', 'सर', 'मैडम', 'मैम'].map((phrase) =>
  phrase.split(' '),
);
/** A longer utterance is never only a backchannel, whatever its words. */
const MAX_BACKCHANNEL_WORDS = 6;
const IDLE_DEFAULT = { timeoutMs: 10000, maxRetries: 1, prompts: ['Are you still there?'] };
const DTMF_DEFAULT = {
  interDigitMs: 2000,
  terminator: '#',
  maxDigits: 32,
  interruptOnFirstDigit: true,
};

/** A turn detector's row config (§2.7). `mute: []` means `defaultMuteRules(mode)`. */
export const TurnConfigSchema = z
  .object({
    /** auto → vad-timeout when a VAD is selected, otherwise provider. */
    strategy: z.enum(['auto', 'provider', 'vad-timeout']).default('auto'),
    userSpeechTimeoutMs: z.number().int().min(0).max(60000).default(600),
    stopTimeoutMs: z.number().int().min(0).max(120000).default(5000),
    waitForTranscript: z.boolean().default(true),
    sttP99Ms: z.number().int().positive().max(60000).optional(),
    minWordsWhileBotSpeaking: z.number().int().min(0).max(20).default(2),
    backchannels: z
      .array(z.string().min(1).max(80))
      .max(100)
      .default(() => [...BACKCHANNELS]),
    /**
     * AGT-9, per agent: true ignores a backchannel said while the agent speaks (it neither barges
     * in nor starts a turn); false lets any word barge in.
     */
    backchannelsEnabled: z.boolean().default(true),
    mute: z
      .array(z.enum(MUTE_RULES))
      .max(MUTE_RULES.length)
      .default(() => []),
    allowDtmfWhileMuted: z.boolean().default(true),
    idle: z
      .object({
        timeoutMs: z.number().int().positive().max(600000).default(IDLE_DEFAULT.timeoutMs),
        maxRetries: z.number().int().min(0).max(10).default(IDLE_DEFAULT.maxRetries),
        prompts: z
          .array(z.string().min(1).max(500))
          .max(10)
          .default(() => [...IDLE_DEFAULT.prompts]),
      })
      .strict()
      .nullable()
      .default(() => ({ ...IDLE_DEFAULT, prompts: [...IDLE_DEFAULT.prompts] })),
    dtmf: z
      .object({
        interDigitMs: z.number().int().positive().max(60000).default(DTMF_DEFAULT.interDigitMs),
        terminator: z.string().max(1).default(DTMF_DEFAULT.terminator),
        maxDigits: z.number().int().positive().max(128).default(DTMF_DEFAULT.maxDigits),
        interruptOnFirstDigit: z.boolean().default(DTMF_DEFAULT.interruptOnFirstDigit),
      })
      .strict()
      .default(() => ({ ...DTMF_DEFAULT })),
    /**
     * LAT-6: when a caller turn's reply has no audio `afterMs` into the turn, one of these lines
     * plays (in rotation, at most once per utterance). Fixed lines, so they are pre-rendered into
     * the release's clip inventory. null (the default) plays none.
     */
    filler: z
      .object({
        lines: z.array(z.string().min(1).max(200)).min(1).max(10),
        afterMs: z.number().int().min(100).max(10000).default(600),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type TurnConfig = z.output<typeof TurnConfigSchema>;

/**
 * The fixed lines a turn detector's row config speaks: its idle prompts and LAT-6 filler lines,
 * for the release's clip inventory. Read leniently: a detector's own extra fields (the default
 * detector's `commit` strategy, say) never hide them. Absent fields take their defaults.
 */
export function turnDetectorLines(config: unknown): { idle: string[]; filler: string[] } {
  const row = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const parsed = TurnConfigSchema.pick({ idle: true, filler: true }).safeParse({
    ...(row.idle === undefined ? {} : { idle: row.idle }),
    ...(row.filler === undefined ? {} : { filler: row.filler }),
  });
  if (!parsed.success) return { idle: [], filler: [] };
  return { idle: parsed.data.idle?.prompts ?? [], filler: parsed.data.filler?.lines ?? [] };
}

/**
 * True when `text`, said while the agent speaks, only acknowledges it (AGT-9): fewer words than
 * `minWordsWhileBotSpeaking`, one of `backchannels`, or a run of them ("haan haan", "ok theek hai"),
 * optionally with a form of address ("ok sir", "yes madam"). Always false when
 * `backchannelsEnabled` is off.
 */
export function isBackchannel(
  text: string,
  language: string,
  config: Pick<TurnConfig, 'minWordsWhileBotSpeaking' | 'backchannels' | 'backchannelsEnabled'>,
): boolean {
  if (!config.backchannelsEnabled) return false;
  if (countWords(text, language) < config.minWordsWhileBotSpeaking) return true;
  const words = normalizeForMatch(text).split(' ').filter(Boolean);
  if (!words.length || words.length > MAX_BACKCHANNEL_WORDS) return false;
  const phrases = config.backchannels
    .map((entry) => normalizeForMatch(entry).split(' ').filter(Boolean))
    .filter((phrase) => phrase.length);
  const at = (phrase: readonly string[], start: number) =>
    phrase.every((word, offset) => words[start + offset] === word);
  // reach[i]: the first i words are a run of phrases; 2 once a backchannel is among them, 1 while
  // they are only forms of address.
  const reach = [1, ...words.map(() => 0)];
  for (let start = 0; start < words.length; start += 1) {
    if (!reach[start]) continue;
    for (const phrase of phrases) if (at(phrase, start)) reach[start + phrase.length] = 2;
    for (const phrase of HONORIFICS)
      if (at(phrase, start))
        reach[start + phrase.length] = Math.max(reach[start + phrase.length]!, reach[start]!);
  }
  return reach[words.length] === 2;
}

export interface TurnDetectorFactory {
  /** The plugin's own row config is its TurnConfig; `overrides` come from the engine. */
  create(input: {
    clock: Clock;
    stt?: SpeechCapabilities;
    vad: boolean;
    language: string;
    mode: Mode;
    overrides?: Partial<TurnConfig>;
  }): UserTurnController;
}

const DEFAULT_MUTE: Readonly<Record<Mode, readonly MuteRule[]>> = Object.freeze({
  announcement: Object.freeze(['always-while-speaking'] as const),
  faq: Object.freeze(['during-confirmation'] as const),
  context: Object.freeze(['during-confirmation'] as const),
  agent: Object.freeze(['during-tools', 'during-confirmation'] as const),
});

/** The §2.7 table: announcement never barges in; answers to a confirmation prompt are never lost. */
export function defaultMuteRules(mode: Mode): MuteRule[] {
  return [...DEFAULT_MUTE[mode]];
}
