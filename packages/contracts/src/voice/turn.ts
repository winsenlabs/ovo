import { z } from 'zod';
import type { Mode } from '../agent.ts';
import type { Clock } from '../clock.ts';
import type { SpeechCapabilities } from '../speech/capabilities.ts';
import type { SttEvent } from '../speech/stt.ts';
import type { SpeechKindV2 } from './evidence.ts';

export type VoiceEvent =
  | { type: 'stt'; event: SttEvent; atMs: number }
  | { type: 'vad.start' | 'vad.stop'; atMs: number }
  | { type: 'dtmf'; digit: string; atMs: number }
  | { type: 'bot.started' | 'bot.stopped'; epoch: number; atMs: number; kind?: SpeechKindV2 }
  | { type: 'tool.started' | 'tool.settled'; atMs: number }
  | { type: 'confirmation.pending' | 'confirmation.resolved'; atMs: number };

export type TurnDecision =
  | { type: 'interrupt'; reason: 'vad' | 'transcript' | 'dtmf' }
  | { type: 'turn.started'; turnId: string }
  | {
      type: 'turn.stopped';
      turnId: string;
      input: { kind: 'speech'; text: string; segments: number } | { kind: 'dtmf'; digits: string };
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

const BACKCHANNELS = [
  'uh huh',
  'mm hmm',
  'yeah',
  'yes',
  'ok',
  'okay',
  'right',
  'haan',
  'achha',
  'hmm',
];
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
  })
  .strict();
export type TurnConfig = z.output<typeof TurnConfigSchema>;

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
