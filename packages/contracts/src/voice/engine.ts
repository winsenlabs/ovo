import { Mode } from '../agent.ts';
import type { AudioFormat } from '../audio.ts';
import { Acknowledgement } from '../selection.ts';
import type { CallOutcome, EndReason } from './end-reason.ts';
import type { SpeechEvidence } from './evidence.ts';

export interface SessionInput {
  /** Lets turn detectors pick default mute rules. */
  mode: Mode;
  language: string;
  inputEnabled: boolean;
  initialInput?: string;
  /** Delivered on EVERY behavior call (#4). */
  variables: Readonly<Record<string, unknown>>;
  /** Watchdog (#26); the carrier TimeLimit is this + 30. */
  maxCallSeconds: number;
  acknowledgements: readonly Acknowledgement[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Strict draft-07 JSON Schema for `SessionInput`. Engines embed it as `configSchema.properties.session`. */
export const SESSION_INPUT_JSON_SCHEMA: Record<string, unknown> = deepFreeze({
  type: 'object',
  required: ['mode', 'language', 'inputEnabled', 'variables', 'maxCallSeconds', 'acknowledgements'],
  properties: {
    mode: { type: 'string', enum: [...Mode.options] },
    language: { type: 'string', minLength: 1 },
    inputEnabled: { type: 'boolean' },
    initialInput: { type: 'string' },
    variables: { type: 'object' },
    maxCallSeconds: { type: 'integer', minimum: 1, maximum: 14400 },
    acknowledgements: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: [...Acknowledgement.options] },
    },
  },
  additionalProperties: false,
});

/** VoiceSessionEngine v2 (capability `ovo.voice-session-engine@2`). */
export interface VoiceSessionEngine {
  start(): Promise<void>;
  /** Idempotent and bounded (deadline default 2000 ms); closes media first. */
  dispose(reason: EndReason, opts?: { deadlineMs?: number }): Promise<EngineOutcome>;
  readonly ended: Promise<EngineOutcome>;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  readonly ingressStats: {
    acceptedFrames: number;
    acceptedBytes: number;
    pendingFrames: number;
    pendingBytes: number;
    overflows: number;
  };
}

export interface EngineOutcome {
  reason: EndReason;
  outcome: CallOutcome;
}

export type StageKey =
  | 'vad_stop_wait'
  | 'stt_finalize'
  | 'turn_decision'
  | 'behavior_first_segment'
  | 'llm_ttfb'
  | 'text_aggregation'
  | 'tts_ttfb'
  | 'carrier_first_audio'
  | 'playout_ack'
  | 'bargein_latency'
  | `tool:${string}`;

export type EngineEvent =
  /** Phases in order: generated→queued→started→sent→acknowledged→completed|interrupted|dropped|failed. */
  | { type: 'speech'; evidence: SpeechEvidence }
  | {
      type: 'user.transcript';
      turnId: string;
      segmentId: string;
      text: string;
      stability: 'interim' | 'final';
    }
  | {
      type: 'user.turn';
      phase: 'started' | 'stopped' | 'idle';
      turnId: string;
      input?: 'speech' | 'dtmf';
      text?: string;
    }
  | {
      type: 'agent.transcript';
      segmentId: string;
      text: string;
      state: 'generated' | 'played' | 'interrupted';
      spokenPrefix?: string;
    }
  | {
      type: 'timing';
      key: StageKey;
      turnId?: string;
      segmentId?: string;
      atMs: number;
      ms?: number;
    }
  | { type: 'interrupt'; reason: 'vad' | 'transcript' | 'dtmf' }
  | { type: 'voicemail'; result: 'human' | 'machine' | 'unknown' }
  | { type: 'end'; reason: EndReason };

/** Receives user and agent transcript events (capability `ovo.transcript-observer`). */
export type TranscriptObserver = (
  event: Extract<EngineEvent, { type: 'user.transcript' | 'agent.transcript' }>,
) => void;

export interface EngineCapabilities {
  turnDetection: readonly ('provider' | 'vad-timeout' | 'smart-turn' | 'stt')[];
  bargeIn: boolean;
  dtmf: boolean;
  confirmedPlayback: boolean;
  ownsProviders: false;
  formats: readonly AudioFormat[];
  consumesTurnDetector: boolean;
}
