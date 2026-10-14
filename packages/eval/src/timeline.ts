// What a call's pipeline produced, from its engine events: the caller's turns as the detector ended
// them, the STT's transcripts, every agent line and whether it was heard, and the LLM requests.
// Built the same way from a live call's export and from a replay, so both are scored alike.
import type { EngineEvent, SpeechEvidence } from '@winsendotai/ovo-contracts';
import type { LlmRequest, TimedEngineEvent } from './log/export.ts';

export interface CallerTurn {
  turnId: string;
  startedAtMs: number;
  /** When the detector ended it (`stopped`) or dropped it (`reset`); absent if still open. */
  endedAtMs?: number;
  outcome: 'stopped' | 'reset' | 'open';
  input?: 'speech' | 'dtmf';
  text?: string;
  /** The caller's last voiced audio to the turn's end (OBS-5). */
  endpointMs?: number;
  rule?: string;
  resetReason?: string;
}

export interface AgentLine {
  segmentId: string;
  epoch: number;
  kind: string;
  text: string;
  generatedAtMs: number;
  /** The caller turn the line answers, when the engine said (its timing events). */
  turnId?: string;
  /** First audio at the carrier: absent for a line never heard. */
  audibleAtMs?: number;
  endedAtMs?: number;
  outcome: 'completed' | 'interrupted' | 'dropped' | 'failed' | 'open';
  reason?: string;
}

export interface Transcript {
  atMs: number;
  segmentId: string;
  text: string;
  final: boolean;
}

export interface CallTimeline {
  turns: CallerTurn[];
  agent: AgentLine[];
  transcripts: Transcript[];
  llm: LlmRequest[];
  interrupts: { atMs: number; reason: string }[];
  end?: { atMs: number; reason: string };
  /** The last event's time. */
  durationMs: number;
}

type Speech = Extract<EngineEvent, { type: 'speech' }>;

function line(atMs: number, evidence: SpeechEvidence): AgentLine {
  return {
    segmentId: evidence.segmentId,
    epoch: evidence.epoch,
    kind: evidence.kind,
    text: evidence.text,
    generatedAtMs: atMs,
    outcome: 'open',
  };
}

function onSpeech(lines: Map<string, AgentLine>, atMs: number, { evidence }: Speech): void {
  const known = lines.get(evidence.segmentId) ?? line(atMs, evidence);
  lines.set(evidence.segmentId, known);
  switch (evidence.phase) {
    case 'sent':
    case 'acknowledged':
      known.audibleAtMs ??= atMs;
      break;
    case 'completed':
    case 'interrupted':
    case 'dropped':
    case 'failed':
      if (known.outcome !== 'open') break;
      known.outcome = evidence.phase;
      known.endedAtMs = atMs;
      if (evidence.reason) known.reason = evidence.reason;
      // A completed line was heard even when no `sent` phase was logged for it.
      if (evidence.phase === 'completed') known.audibleAtMs ??= atMs;
      break;
    default:
      break;
  }
}

export function buildTimeline(
  events: readonly TimedEngineEvent[],
  llm: readonly LlmRequest[] = [],
): CallTimeline {
  const turns = new Map<string, CallerTurn>();
  const lines = new Map<string, AgentLine>();
  const segmentTurns = new Map<string, string>();
  const timeline: CallTimeline = {
    turns: [],
    agent: [],
    transcripts: [],
    llm: [...llm],
    interrupts: [],
    durationMs: events.at(-1)?.atMs ?? 0,
  };
  for (const { atMs, event } of events) {
    switch (event.type) {
      case 'user.turn': {
        if (event.phase === 'idle') break;
        if (event.phase === 'started') {
          const turn: CallerTurn = { turnId: event.turnId, startedAtMs: atMs, outcome: 'open' };
          turns.set(event.turnId, turn);
          timeline.turns.push(turn);
          break;
        }
        const turn = turns.get(event.turnId);
        if (!turn || turn.outcome !== 'open') break;
        turn.outcome = event.phase;
        turn.endedAtMs = atMs;
        if (event.input) turn.input = event.input;
        if (event.text !== undefined) turn.text = event.text;
        if (event.endpointMs !== undefined) turn.endpointMs = event.endpointMs;
        if (event.endpointRule !== undefined) turn.rule = event.endpointRule;
        if (event.resetReason !== undefined) turn.resetReason = event.resetReason;
        break;
      }
      case 'user.transcript':
        timeline.transcripts.push({
          atMs,
          segmentId: event.segmentId,
          text: event.text,
          final: event.stability === 'final',
        });
        break;
      case 'speech':
        onSpeech(lines, atMs, event);
        break;
      case 'timing': {
        // A line's timings name its turn (text_aggregation comes before the line's own evidence);
        // carrier_first_audio is its first audio at the carrier.
        if (!event.segmentId) break;
        if (event.turnId && !segmentTurns.has(event.segmentId))
          segmentTurns.set(event.segmentId, event.turnId);
        const known = lines.get(event.segmentId);
        if (known && event.key === 'carrier_first_audio') known.audibleAtMs ??= atMs;
        break;
      }
      case 'interrupt':
        timeline.interrupts.push({ atMs, reason: event.reason });
        break;
      case 'end':
        timeline.end = { atMs, reason: event.reason };
        break;
      default:
        break;
    }
  }
  timeline.agent = [...lines.values()].sort((a, b) => a.generatedAtMs - b.generatedAtMs);
  for (const line of timeline.agent) {
    const turnId = segmentTurns.get(line.segmentId);
    if (turnId) line.turnId = turnId;
  }
  return timeline;
}

/** The caller's speech span of a stopped turn: from its start to its last voiced audio. */
export function speechSpan(turn: CallerTurn): { startMs: number; endMs: number } {
  const end = turn.endedAtMs ?? turn.startedAtMs;
  return {
    startMs: turn.startedAtMs,
    endMs: Math.max(turn.startedAtMs, end - (turn.endpointMs ?? 0)),
  };
}
