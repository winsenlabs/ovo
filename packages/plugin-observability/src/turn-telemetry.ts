import type { EngineEvent } from '@winsendotai/ovo-contracts';
import type {
  TurnDecisionAnswer,
  TurnDecisionTelemetry,
  TurnStageSample,
  TurnTelemetry,
} from './turn-telemetry-types.ts';

export type {
  TurnDecisionAnswer,
  TurnDecisionTelemetry,
  TurnSegmentTelemetry,
  TurnStageSample,
  TurnTelemetry,
} from './turn-telemetry-types.ts';

/** Bounds keep one summary well inside the 16 KiB telemetry payload limit. */
const MAX_TEXT_CHARACTERS = 1_500;
const MAX_SEGMENTS = 16;
const MAX_ANSWERS = 16;
const MAX_TURNS = 200;

interface SegmentState {
  textReadyAt?: number;
  ttsAt?: number;
  audioAt?: number;
  text?: string;
  state?: string;
}

interface TurnState {
  turn: Omit<TurnTelemetry, 'startedAt' | 'firstAudioMs' | 'segments' | 'agentText'>;
  startAt?: number;
  segments: Map<string, SegmentState>;
  dirty: boolean;
}

/**
 * Folds engine events and worker-measured provider stages into one record per turn. Provider
 * stages carry no turn of their own; they belong to the turn that most recently started, which is
 * exact because the engine runs turns one at a time.
 */
export class TurnTelemetryCollector {
  private readonly turns = new Map<string, TurnState>();
  private readonly segmentTurns = new Map<string, string>();
  private active?: string;
  private pendingEndpointMs?: number;

  constructor(
    private readonly options: { includeText: boolean; emit: (turn: TurnTelemetry) => void },
  ) {}

  get activeTurnId(): string | undefined {
    return this.active;
  }

  engine(event: EngineEvent): void {
    if (event.type === 'timing' && event.turnId) this.timing(event, event.turnId);
    else if (event.type === 'user.turn' && event.phase === 'started') {
      // The provider ends a turn after it starts. An end-of-turn still pending here belonged to an
      // utterance that never became a turn (muted) or to one the controller already stopped.
      this.pendingEndpointMs = undefined;
    } else if (event.type === 'user.turn' && event.phase === 'stopped') {
      const state = this.state(event.turnId);
      state.turn.input = event.input ?? 'speech';
      // DTMF digits can be PINs or card numbers; only spoken input is kept as text.
      state.turn.userText = state.turn.input === 'speech' ? bounded(event.text) : null;
      if (state.turn.input === 'speech') {
        state.turn.endpointMs = this.pendingEndpointMs ?? null;
        this.pendingEndpointMs = undefined;
      }
      state.dirty = true;
    } else if (event.type === 'agent.transcript') {
      const segment = this.segment(event.segmentId);
      if (segment && event.state === 'generated') segment.text = event.text;
    } else if (event.type === 'interrupt' && this.active) {
      const state = this.turns.get(this.active);
      if (state) {
        state.turn.interrupted = true;
        state.dirty = true;
      }
    } else if (event.type === 'speech') {
      const { phase, segmentId } = event.evidence;
      if (!['completed', 'interrupted', 'dropped', 'failed'].includes(phase)) return;
      const turnId = this.segmentTurns.get(segmentId);
      const segment = this.segment(segmentId);
      if (!turnId || !segment) return;
      segment.state = phase;
      const state = this.turns.get(turnId)!;
      // A filler cut by its own reply (P3) is no interruption; a barge-in sends 'interrupt'.
      if (phase === 'interrupted' && event.evidence.kind !== 'acknowledgment')
        state.turn.interrupted = true;
      state.dirty = true;
      this.publish(turnId);
    }
  }

  stage(sample: TurnStageSample): void {
    if (sample.stage === 'stt.endpoint') {
      // The provider ends the caller's turn before the engine accepts it.
      this.pendingEndpointMs = sample.durationMs;
      return;
    }
    const turnId = sample.turnId ?? this.active;
    const state = turnId === undefined ? undefined : this.turns.get(turnId);
    if (!state) return;
    const turn = state.turn;
    if (sample.stage === 'grounding')
      turn.groundingMs = (turn.groundingMs ?? 0) + sample.durationMs;
    else if (sample.stage === 'decision') turn.decision = decisionOf(sample);
    else if (sample.stage === 'llm_first_token') {
      if (sample.outcome === 'succeeded') turn.llmFirstTokenMs ??= sample.durationMs;
    } else if (sample.stage === 'inference') {
      turn.llmTotalMs = (turn.llmTotalMs ?? 0) + sample.durationMs;
      turn.llmCalls += 1;
    } else if (sample.stage === 'web_search') {
      turn.searchMs = (turn.searchMs ?? 0) + sample.durationMs;
      turn.searchCalls += 1;
      const results = sample.payload?.results;
      if (typeof results === 'number') turn.searchResults = (turn.searchResults ?? 0) + results;
    } else return;
    state.dirty = true;
  }

  /** Publish every turn that changed since its last summary. */
  flush(): void {
    for (const turnId of [...this.turns.keys()]) this.publish(turnId);
  }

  private timing(event: Extract<EngineEvent, { type: 'timing' }>, turnId: string): void {
    const state = this.state(turnId);
    state.startAt ??= event.atMs - (event.ms ?? 0);
    const turn = state.turn;
    const ms = event.ms ?? null;
    if (event.key === 'vad_stop_wait') turn.vadStopToFinalMs = ms;
    else if (event.key === 'stt_finalize') turn.sttFinalizeMs = ms;
    else if (event.key === 'turn_decision') {
      turn.queueMs = ms;
      if (this.active !== turnId)
        for (const other of [...this.turns.keys()]) if (other !== turnId) this.publish(other);
      this.active = turnId;
    } else if (event.key === 'behavior_first_segment') turn.firstSegmentMs ??= ms;
    else if (event.key === 'bargein_latency') {
      turn.bargeInMs = ms;
      turn.interrupted = true;
    } else if (event.segmentId) {
      let segment = state.segments.get(event.segmentId);
      if (!segment && state.segments.size < MAX_SEGMENTS) {
        segment = {};
        state.segments.set(event.segmentId, segment);
        this.segmentTurns.set(event.segmentId, turnId);
      }
      if (!segment) return;
      if (event.key === 'text_aggregation') segment.textReadyAt ??= event.atMs;
      else if (event.key === 'tts_ttfb') segment.ttsAt ??= event.atMs;
      else if (event.key === 'carrier_first_audio') segment.audioAt ??= event.atMs;
    }
    state.dirty = true;
  }

  private segment(segmentId: string): SegmentState | undefined {
    const turnId = this.segmentTurns.get(segmentId);
    return turnId === undefined ? undefined : this.turns.get(turnId)?.segments.get(segmentId);
  }

  private state(turnId: string): TurnState {
    let state = this.turns.get(turnId);
    if (state) return state;
    state = { turn: emptyTurn(turnId), segments: new Map(), dirty: true };
    this.turns.set(turnId, state);
    if (this.turns.size > MAX_TURNS) this.evict();
    return state;
  }

  private evict(): void {
    for (const [turnId, state] of this.turns) {
      if (turnId === this.active) continue;
      this.publish(turnId);
      for (const segmentId of state.segments.keys()) this.segmentTurns.delete(segmentId);
      this.turns.delete(turnId);
      return;
    }
  }

  private publish(turnId: string): void {
    const state = this.turns.get(turnId);
    if (!state?.dirty) return;
    state.dirty = false;
    this.options.emit(this.snapshot(state));
  }

  private snapshot(state: TurnState): TurnTelemetry {
    const start = state.startAt;
    const since = (at: number | undefined) =>
      at === undefined || start === undefined ? null : Math.max(0, at - start);
    const segments = [...state.segments].map(([segmentId, segment]) => ({
      segmentId,
      ttsFirstByteMs: interval(segment.textReadyAt, segment.ttsAt),
      carrierFirstAudioMs: interval(segment.ttsAt ?? segment.textReadyAt, segment.audioAt),
      firstAudioAtMs: since(segment.audioAt),
      state: segment.state ?? null,
    }));
    const audio = segments.flatMap((segment) =>
      segment.firstAudioAtMs === null ? [] : [segment.firstAudioAtMs],
    );
    const agentText = [...state.segments.values()]
      .flatMap((segment) => (segment.text ? [segment.text] : []))
      .join(' ');
    const include = this.options.includeText;
    return {
      ...state.turn,
      startedAt: start === undefined ? null : new Date(start).toISOString(),
      firstAudioMs: audio.length ? Math.min(...audio) : null,
      segments,
      userText: include ? state.turn.userText : null,
      agentText: include && agentText ? bounded(agentText) : null,
      textOmitted: !include,
    };
  }
}

function emptyTurn(turnId: string): TurnState['turn'] {
  return {
    turnId,
    input: turnId.startsWith('initial-') ? 'initial' : 'agent',
    endpointMs: null,
    vadStopToFinalMs: null,
    sttFinalizeMs: null,
    queueMs: null,
    groundingMs: null,
    decision: null,
    llmFirstTokenMs: null,
    llmTotalMs: null,
    llmCalls: 0,
    searchMs: null,
    searchCalls: 0,
    searchResults: null,
    firstSegmentMs: null,
    bargeInMs: null,
    interrupted: false,
    userText: null,
    textOmitted: false,
  };
}

function decisionOf(sample: TurnStageSample): TurnDecisionTelemetry {
  const payload = sample.payload ?? {};
  const answers = Array.isArray(payload.answers) ? payload.answers.slice(0, MAX_ANSWERS) : [];
  return {
    ms: sample.durationMs,
    outcome: sample.outcome,
    modelId: typeof payload.modelId === 'string' ? payload.modelId : null,
    answers: answers as TurnDecisionAnswer[],
    flow: flowOf(payload.flow),
  };
}

function flowOf(raw: unknown): TurnDecisionTelemetry['flow'] {
  if (!raw || typeof raw !== 'object') return null;
  const { node, listen } = raw as Record<string, unknown>;
  if (typeof listen !== 'string') return null;
  return { node: typeof node === 'string' ? node : null, listen };
}

function interval(from: number | undefined, to: number | undefined): number | null {
  return from === undefined || to === undefined ? null : Math.max(0, to - from);
}

function bounded(text: string | undefined): string | null {
  if (text === undefined) return null;
  return text.length > MAX_TEXT_CHARACTERS ? text.slice(0, MAX_TEXT_CHARACTERS) : text;
}
