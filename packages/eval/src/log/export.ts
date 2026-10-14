// A call's control-plane event export (`/v1/calls/:id/events`: one JSON object per line, or a JSON
// array), reduced to what the harness scores. Every time is in ms since `session.started`, the
// zero the gold files use too.
import type { EngineEvent } from '@winsendotai/ovo-contracts';

export interface ExportedEvent {
  callId?: string;
  sequence?: number;
  at?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface TimedEngineEvent {
  atMs: number;
  event: EngineEvent;
}

/** One LLM request, from its metered usage (`provider.usage`, operation `inference`). */
export interface LlmRequest {
  /** When it was sent: the usage row's time less the request's elapsed time. */
  atMs: number;
  id: string;
  elapsedMs?: number;
  /** The plugin estimated the usage of a request it aborted (speculation thrown away). */
  estimated?: boolean;
}

export interface CallEvents {
  callId: string;
  /** Epoch ms of `session.started`. */
  startedAt: number;
  engine: TimedEngineEvent[];
  llm: LlmRequest[];
  /** The `speculation.summary` row's LLM counts, when the call logged one. */
  speculation?: Record<string, number>;
  endReason?: string;
}

/** JSON lines, a JSON array, or `{ events: [...] }`. */
export function parseExport(text: string): ExportedEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as ExportedEvent[];
  if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    const value = JSON.parse(trimmed) as { events?: ExportedEvent[] } & ExportedEvent;
    return value.events ?? [value];
  }
  if (trimmed.startsWith('{"events"'))
    return (JSON.parse(trimmed) as { events: ExportedEvent[] }).events;
  return trimmed
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ExportedEvent);
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

/**
 * The engine events in order and the LLM requests. The engine stamps its own events (`atMs`, epoch
 * ms on the worker's clock); other rows only carry the time the control plane stored them.
 */
export function callEvents(rows: readonly ExportedEvent[]): CallEvents {
  const started = rows.find((row) => row.type === 'session.started');
  const firstAt = rows.find((row) => row.at)?.at;
  const zero = started?.at ?? firstAt;
  if (!zero) throw new Error('event export has no timestamps');
  const startedAt = Date.parse(zero);
  const out: CallEvents = {
    callId: started?.callId ?? rows[0]?.callId ?? '',
    startedAt,
    engine: [],
    llm: [],
  };
  const requests = new Map<string, LlmRequest>();
  for (const row of rows) {
    const payload = record(row.payload) ?? {};
    const storedAt = row.at ? Date.parse(row.at) - startedAt : NaN;
    if (row.type === 'engine.event') {
      const event = record(payload.event) as EngineEvent | undefined;
      const at = typeof payload.atMs === 'number' ? payload.atMs - startedAt : storedAt;
      if (event && typeof event.type === 'string' && Number.isFinite(at))
        out.engine.push({ atMs: at, event });
    } else if (row.type === 'provider.usage' && payload.operation === 'inference') {
      const id = String(payload.requestId ?? '');
      if (!id || requests.has(id) || !Number.isFinite(storedAt)) continue;
      const elapsedMs = typeof payload.elapsedMs === 'number' ? payload.elapsedMs : undefined;
      requests.set(id, {
        atMs: storedAt - (elapsedMs ?? 0),
        id,
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        ...(payload.state === 'estimated' ? { estimated: true } : {}),
      });
    } else if (row.type === 'speculation.summary') {
      const llm = record(payload.llm);
      if (llm)
        out.speculation = Object.fromEntries(
          Object.entries(llm).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number',
          ),
        );
    } else if (row.type === 'session.ended' && typeof payload.reason === 'string') {
      out.endReason = payload.reason;
    }
  }
  out.engine.sort((a, b) => a.atMs - b.atMs);
  out.llm = [...requests.values()].sort((a, b) => a.atMs - b.atMs);
  return out;
}

/** The rows the harness reads, for a corpus small enough to commit (`eval:calls slim`). */
export function slimExport(rows: readonly ExportedEvent[]): ExportedEvent[] {
  const keep = new Set(['user.transcript', 'user.turn', 'speech', 'timing', 'interrupt', 'end']);
  // The timings that name a line's turn and its first audio; the rest are latency breakdowns.
  const timings = new Set(['text_aggregation', 'carrier_first_audio']);
  return (
    rows
      .filter((row) => {
        if (row.type === 'engine.event') {
          const event = record(row.payload?.event);
          if (!event || !keep.has(String(event.type))) return false;
          if (event.type === 'timing') return timings.has(String(event.key));
          // Speech evidence: the phases the timeline reads.
          if (event.type === 'speech') {
            const phase = record(event.evidence)?.phase;
            return ['generated', 'sent', 'completed', 'interrupted', 'dropped', 'failed'].includes(
              String(phase),
            );
          }
          return true;
        }
        if (row.type === 'provider.usage')
          return row.payload?.operation === 'inference' && row.payload?.unit === 'input_tokens';
        return ['session.started', 'session.ended', 'speculation.summary'].includes(
          String(row.type),
        );
      })
      // Engine events carry their own time; the stored time and ids only weigh the file down.
      .map(({ callId, at, type, payload }) =>
        type === 'engine.event' ? { type, payload } : { callId, at, type, payload },
      )
  );
}
