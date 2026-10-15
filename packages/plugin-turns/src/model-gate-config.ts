import type {
  TurnDecision,
  TurnDetectorFactory,
  UserTurnController,
} from '@winsendotai/ovo-contracts';
import { z } from 'zod';
import { DetectorConfigSchema } from './config.ts';

/**
 * Wave 13 (T1): a model-based end-of-turn detector hosted behind the turn-detector interface. The
 * rules detector (TurnController) still does everything else (barge-in, backchannels, mutes, the
 * opening, DTMF, idle prompts, commits); the gate sits on its `turn.stopped`. When the rules end a
 * turn, the model reads it (the caller's audio, or the words and the agent's line before them): a
 * turn it reads as finished ends at once, one it reads as unfinished waits `holdMs` for the caller
 * to go on, and words in that wait continue the same turn (one `turn.started`, one `turn.stopped`
 * with all the words), so no reply is asked for half a sentence. Model runtimes live in their own
 * packages (plugin-turn-detector-smart-turn, plugin-turn-detector-livekit); this module only needs
 * their shape.
 */
export interface EndOfTurnRequest {
  /** The caller's audio from just before the turn started, 16 kHz mono, newest sample last. */
  audio?: Int16Array;
  /** The caller's words in the turn so far. */
  text: string;
  /** The agent's last line before them, when the host passes it on (`agentSaid`). */
  agentText?: string;
  /** The session language (BCP 47). */
  language: string;
}

export interface EndOfTurnModel {
  readonly name: string;
  /** What the model reads: an audio model has nothing to read until the host passes audio. */
  readonly input: 'audio' | 'text';
  /**
   * The probability, in [0, 1], that the caller has finished. A model that answers synchronously
   * (a number, not a promise) is applied at once, as the turn@1 conformance driver expects.
   */
  predict(request: EndOfTurnRequest): number | Promise<number>;
  /** Below this the turn is unlikely to be over; undefined: the model does not cover the language. */
  threshold(language: string): number | undefined;
}

export const ModelGateConfigSchema = z
  .object({
    /** Overrides the model's own (per-language) threshold. */
    threshold: z.number().min(0).max(1).optional(),
    /**
     * How long a turn the model reads as unfinished waits for the caller to go on before it ends
     * anyway, from the rules' stop. LiveKit Agents waits up to 3 s from the VAD's end of speech,
     * which comes ~0.5 s before the rules' stop on these calls.
     */
    holdMs: z.number().int().min(0).max(10000).default(2500),
    /**
     * An audio model reads a held turn again this often, its audio now ending on the longer
     * silence: once it reads finished, the turn ends without serving the rest of the hold. 0 never
     * reads again (LiveKit Agents and Pipecat read once).
     */
    recheckMs: z.number().int().min(0).max(5000).default(0),
    /** A prediction slower than this is not waited for: the turn ends as the rules decided. */
    timeoutMs: z.number().int().min(50).max(5000).default(1000),
    /** Audio from this long before the turn's start reaches an audio model too. */
    preRollMs: z.number().int().min(0).max(2000).default(300),
    /** The longest audio kept for an audio model (Smart Turn reads 8 s, LiveKit's 1.2 s). */
    audioMs: z.number().int().min(1000).max(30000).default(8000),
    /** The minimal safety rules kept beside the model. */
    safety: z
      .object({
        /**
         * Short replies that answer by themselves ("Yes.", "हाँ।", "No", "15", a backchannel) end at
         * once, unread: the audio models are not made for a word or two of audio.
         */
        shortAnswers: z.boolean().default(true),
        /** Words the STT broke off ("…any-", "so...") wait out the hold whatever the model reads. */
        brokenOff: z.boolean().default(true),
        /**
         * Words that end on a question mark end at once, unread: a question hands the floor over
         * (off by default; the bake-off measures it).
         */
        questions: z.boolean().default(false),
      })
      .strict()
      .default(() => ({ shortAnswers: true, brokenOff: true, questions: false })),
  })
  .strict();
export type ModelGateConfig = z.output<typeof ModelGateConfigSchema>;

/** A model detector's row: the rules detector's row, plus the gate's `model` settings. */
export const ModelDetectorConfigSchema = DetectorConfigSchema.extend({
  model: ModelGateConfigSchema.default(() => ModelGateConfigSchema.parse({})),
});

export interface ModelGateStats {
  /** Turns the rules ended. */
  stops: number;
  /** Predictions made, and the probabilities they gave, in order. */
  predictions: number[];
  /** Turns held for the caller to go on, and the words each was held on. */
  held: string[];
  /** Held turns the caller went on with (merged into one). */
  merged: number;
  /** Probabilities of the readings of held turns (recheckMs), and how many ended a hold. */
  rechecks: number[];
  released: number;
  /**
   * Turns ended unread: a short answer, a question (safety.questions), an unsupported language, or
   * no audio for an audio model.
   */
  bypassed: { shortAnswer: number; question: number; language: number; noAudio: number };
  timeouts: number;
  failures: number;
}

/** What a model detector's controller adds: the caller's audio and the agent's words. */
export interface ModelGatedTurnController extends UserTurnController {
  /** The caller's audio, 8 or 16 kHz mono, in arrival order (each frame as it arrives). */
  audio(pcm: Int16Array, rate: 8000 | 16000): void;
  /** The agent's latest line, which a text model reads as context. */
  agentSaid(text: string): void;
  /** Resolves once no prediction is in flight (replays on a fake clock wait on it). */
  settled(): Promise<void>;
  readonly stats: ModelGateStats;
}

export type ControllerInput = Parameters<TurnDetectorFactory['create']>[0];
/** A speech turn's end, as the rules detector announces it. */
export type SpeechStop = Extract<TurnDecision, { type: 'turn.stopped' }> & {
  input: { kind: 'speech' };
};
