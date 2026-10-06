/** The per-turn breakdown published as `turn.summary` telemetry and served by the turns API. */

export interface TurnDecisionAnswer {
  questionId: string;
  type: string;
  /** The chosen option for a choice question. */
  choice: string | null;
  /** The yes probability for a noul question, or the score for a score question. */
  value: number | null;
  confidence: number;
}

export interface TurnDecisionTelemetry {
  ms: number;
  outcome: string;
  modelId: string | null;
  answers: TurnDecisionAnswer[];
  /** The flow state the decision was asked in; null for a flat policy. */
  flow: { node: string | null; listen: string } | null;
}

export interface TurnSegmentTelemetry {
  segmentId: string;
  /** Segment text ready to first synthesized byte. Null for cached audio. */
  ttsFirstByteMs: number | null;
  /** First synthesized byte (or text ready, for cached audio) to first audio sent to the carrier. */
  carrierFirstAudioMs: number | null;
  /** Turn start to this segment's first audio sent to the carrier. */
  firstAudioAtMs: number | null;
  state: string | null;
}

/** One caller or agent turn. Every duration is its own interval; they are not deltas. */
export interface TurnTelemetry {
  turnId: string;
  input: 'speech' | 'dtmf' | 'initial' | 'agent';
  startedAt: string | null;
  /** Caller's last word to the speech provider's end-of-turn signal. */
  endpointMs: number | null;
  vadStopToFinalMs: number | null;
  /** Final transcript to the turn being accepted. */
  sttFinalizeMs: number | null;
  /** Turn accepted to the turn starting, waiting for an earlier turn or an interruption. */
  queueMs: number | null;
  groundingMs: number | null;
  decision: TurnDecisionTelemetry | null;
  llmFirstTokenMs: number | null;
  llmTotalMs: number | null;
  llmCalls: number;
  /** Behavior invoked to its first text: grounding, decision, LLM and sentence aggregation. */
  firstSegmentMs: number | null;
  /** Turn start (caller silence, for speech) to the first audio sent to the carrier. */
  firstAudioMs: number | null;
  bargeInMs: number | null;
  interrupted: boolean;
  segments: TurnSegmentTelemetry[];
  userText: string | null;
  agentText: string | null;
  textOmitted: boolean;
}

export interface TurnStageSample {
  stage: string;
  durationMs: number;
  outcome: string;
  turnId?: string;
  payload?: Record<string, unknown>;
}
