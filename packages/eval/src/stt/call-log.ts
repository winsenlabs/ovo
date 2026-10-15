// What the live call recorded about the caller: user turns and the production STT's finals,
// timed from the session start, read from the control-plane event export (`callN-events.jsonl`).

export interface UserTurn {
  turnId: string;
  startedMs: number;
  stoppedMs?: number;
  text?: string;
  endpointMs?: number;
  endpointRule?: string;
  /** A turn the engine reset (a backchannel) instead of answering. */
  resetReason?: string;
}

export interface ProductionFinal {
  atMs: number;
  segmentId: string;
  text: string;
}

export interface CallLog {
  callId: string;
  /** Epoch ms of `session.started`, the zero of every other time here. */
  startedAt: number;
  turns: UserTurn[];
  finals: ProductionFinal[];
}

interface ExportedEvent {
  callId?: string;
  at?: string;
  type?: string;
  payload?: { atMs?: number; event?: Record<string, unknown> };
}

/** Parses the JSON-lines export; events before `session.started` are refused. */
export function parseCallLog(jsonl: string): CallLog {
  const events = jsonl
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ExportedEvent);
  const started = events.find((event) => event.type === 'session.started');
  if (!started?.at) throw new Error('event log has no session.started');
  const startedAt = Date.parse(started.at);
  const log: CallLog = { callId: started.callId ?? '', startedAt, turns: [], finals: [] };
  const open = new Map<string, UserTurn>();
  for (const event of events) {
    if (event.type !== 'engine.event') continue;
    const inner = event.payload?.event;
    const at = event.payload?.atMs ?? (event.at ? Date.parse(event.at) : NaN);
    if (!inner || !Number.isFinite(at)) continue;
    const atMs = at - startedAt;
    const turnId = typeof inner.turnId === 'string' ? inner.turnId : '';
    if (inner.type === 'user.turn' && inner.phase === 'started') {
      const turn: UserTurn = { turnId, startedMs: atMs };
      open.set(turnId, turn);
      log.turns.push(turn);
    } else if (inner.type === 'user.turn') {
      const turn = open.get(turnId);
      if (!turn) continue;
      turn.stoppedMs = atMs;
      if (typeof inner.text === 'string') turn.text = inner.text;
      if (typeof inner.endpointMs === 'number') turn.endpointMs = inner.endpointMs;
      if (typeof inner.endpointRule === 'string') turn.endpointRule = inner.endpointRule;
      if (inner.phase === 'reset' && typeof inner.resetReason === 'string')
        turn.resetReason = inner.resetReason;
    } else if (inner.type === 'user.transcript' && inner.stability === 'final') {
      log.finals.push({
        atMs,
        segmentId: String(inner.segmentId ?? ''),
        text: String(inner.text ?? ''),
      });
    }
  }
  return log;
}
