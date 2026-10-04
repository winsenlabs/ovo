import type { EngineEvent, StageKey, VoiceSessionEngine } from '@winsendotai/ovo-contracts';

export interface LatencyPart {
  key: StageKey;
  ownerKind: 'service' | 'setting' | 'pipeline' | 'carrier';
  ms: number;
}

export interface LatencyBreakdown {
  turnId: string;
  measuredFrom: 'user_silence' | 'call_start';
  totalMs: number;
  parts: LatencyPart[];
  interrupted: boolean;
}

interface TurnClock {
  turnId: string;
  measuredFrom: LatencyBreakdown['measuredFrom'];
  startAt: number;
  lastAt: number;
  parts: LatencyPart[];
  interrupted: boolean;
}

function ownerKind(key: StageKey): LatencyPart['ownerKind'] {
  if (key === 'carrier_first_audio' || key === 'playout_ack') return 'carrier';
  if (key === 'vad_stop_wait' || key === 'turn_decision') return 'setting';
  if (key === 'text_aggregation' || key === 'bargein_latency') return 'pipeline';
  return 'service';
}

/**
 * Wall-clock intervals are assigned to the stage that ended each interval. Reported stage.ms
 * values can overlap, so adding them would double count the turn's elapsed time.
 */
export class LatencyBreakdownProjector {
  private readonly turns = new Map<string, TurnClock>();
  private readonly completed: LatencyBreakdown[] = [];
  private readonly segmentTurns = new Map<string, string>();
  private currentTurnId: string | undefined;
  private pendingSilence = new Map<string, number>();
  private pendingInterrupt = new Set<string>();

  constructor(private readonly callStartAtMs?: number) {}

  onEvent(event: EngineEvent, observedAtMs?: number): void {
    if (event.type === 'user.turn' && event.phase === 'stopped') {
      this.currentTurnId = event.turnId;
      if (observedAtMs !== undefined && Number.isFinite(observedAtMs))
        this.pendingSilence.set(event.turnId, observedAtMs);
      return;
    }
    if (event.type === 'agent.transcript' && this.currentTurnId)
      this.segmentTurns.set(event.segmentId, this.currentTurnId);
    if (
      event.type === 'interrupt' ||
      (event.type === 'agent.transcript' && event.state === 'interrupted') ||
      (event.type === 'speech' && event.evidence.phase === 'interrupted')
    ) {
      const segmentId =
        event.type === 'agent.transcript'
          ? event.segmentId
          : event.type === 'speech'
            ? event.evidence.segmentId
            : undefined;
      const turnId = (segmentId && this.segmentTurns.get(segmentId)) ?? this.currentTurnId;
      const turn = turnId && this.turns.get(turnId);
      if (turn) turn.interrupted = true;
      else if (turnId) this.pendingInterrupt.add(turnId);
      return;
    }
    if (event.type !== 'timing' || !Number.isFinite(event.atMs)) return;
    const turnId =
      event.turnId ??
      (event.segmentId && this.segmentTurns.get(event.segmentId)) ??
      this.currentTurnId ??
      'call_start';
    let turn = this.turns.get(turnId);
    if (!turn) {
      const silenceAt = this.pendingSilence.get(turnId);
      this.pendingSilence.delete(turnId);
      const fromSilence = silenceAt !== undefined && silenceAt <= event.atMs;
      const startAt = fromSilence ? silenceAt : (this.callStartAtMs ?? event.atMs);
      turn = {
        turnId,
        measuredFrom: fromSilence ? 'user_silence' : 'call_start',
        startAt,
        lastAt: startAt,
        parts: [],
        interrupted: this.pendingInterrupt.delete(turnId),
      };
      this.turns.set(turnId, turn);
    }
    this.currentTurnId = turnId;
    const elapsed = Math.max(0, event.atMs - turn.lastAt);
    if (elapsed > 0)
      turn.parts.push({ key: event.key, ownerKind: ownerKind(event.key), ms: elapsed });
    turn.lastAt = Math.max(turn.lastAt, event.atMs);
  }

  finish(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    this.completed.push({
      turnId,
      measuredFrom: turn.measuredFrom,
      totalMs: Math.max(0, turn.lastAt - turn.startAt),
      parts: turn.parts,
      interrupted: turn.interrupted,
    });
  }

  snapshot(): LatencyBreakdown[] {
    return [
      ...this.completed,
      ...[...this.turns.values()].map((turn) => ({
        turnId: turn.turnId,
        measuredFrom: turn.measuredFrom,
        totalMs: Math.max(0, turn.lastAt - turn.startAt),
        parts: [...turn.parts],
        interrupted: turn.interrupted,
      })),
    ];
  }
}

export function projectLatencyBreakdowns(
  events: readonly EngineEvent[],
  callStartAtMs?: number,
  observedAtMs?: readonly (number | undefined)[],
): LatencyBreakdown[] {
  const projector = new LatencyBreakdownProjector(callStartAtMs);
  events.forEach((event, index) => projector.onEvent(event, observedAtMs?.[index]));
  return projector.snapshot();
}

export function subscribeLatencyBreakdowns(
  engine: Pick<VoiceSessionEngine, 'subscribe'>,
  onBreakdown: (breakdown: LatencyBreakdown) => void,
  callStartAtMs?: number,
): () => void {
  const projector = new LatencyBreakdownProjector(callStartAtMs);
  let delivered = false;
  return engine.subscribe((event) => {
    projector.onEvent(event);
    if (event.type !== 'end' || delivered) return;
    delivered = true;
    for (const item of projector.snapshot()) onBreakdown(item);
  });
}
