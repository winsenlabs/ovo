import { readSessionEvent, type CallOutcomeSummary } from '@winsendotai/ovo-contracts';
import { applySessionEvent, emptyCallOutcome, type StoredSessionEvent } from './projection.ts';

/** An event on its way to storage. `id` makes a retried write idempotent. */
export interface SessionEventInput {
  id: string;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface SessionEventPage {
  items: StoredSessionEvent[];
  nextCursor: string | null;
}

/**
 * Durable per-call outcomes (AGT-8): the event log and the summary folded from it, written in the
 * same transaction so the two never disagree. Calls are read by id and are workspace scoped.
 */
export interface CallOutcomeStore {
  /** Appends in order and returns how many were new; an id already stored is skipped. */
  append(
    workspaceId: string,
    callId: string,
    events: readonly SessionEventInput[],
  ): Promise<number>;
  get(workspaceId: string, callId: string): Promise<CallOutcomeSummary | undefined>;
  /** Summaries for a page of calls; a call with no events is absent from the map. */
  getMany(
    workspaceId: string,
    callIds: readonly string[],
  ): Promise<Map<string, CallOutcomeSummary>>;
  listEvents(
    workspaceId: string,
    callId: string,
    limit?: number,
    cursor?: string,
  ): Promise<SessionEventPage>;
  close(): Promise<void>;
}

export const SESSION_EVENT_PAGE_MAX = 500;

export function eventPageLimit(limit = 200): number {
  return Math.max(1, Math.min(SESSION_EVENT_PAGE_MAX, Math.trunc(limit)));
}

export function eventCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d{1,9}$/.test(cursor))
    throw Object.assign(new Error('Invalid pagination cursor'), {
      statusCode: 400,
      code: 'invalid_cursor',
    });
  return Number(cursor);
}

/** For tests and installations without PostgreSQL. Holds everything in process memory. */
export class MemoryCallOutcomeStore implements CallOutcomeStore {
  private readonly calls = new Map<
    string,
    { summary: CallOutcomeSummary; events: StoredSessionEvent[]; ids: Set<string> }
  >();

  async append(workspaceId: string, callId: string, events: readonly SessionEventInput[]) {
    const key = `${workspaceId}\u0000${callId}`;
    const call = this.calls.get(key) ?? {
      summary: emptyCallOutcome(callId, new Date().toISOString()),
      events: [],
      ids: new Set<string>(),
    };
    let added = 0;
    for (const input of events) {
      if (call.ids.has(input.id)) continue;
      const event = readSessionEvent(input.type, input.payload);
      call.ids.add(input.id);
      call.events.push({
        callId,
        sequence: call.events.length + 1,
        at: input.at,
        type: event.type,
        payload: event.payload,
      });
      call.summary = applySessionEvent(call.summary, event, input.at);
      added += 1;
    }
    if (added) this.calls.set(key, call);
    return added;
  }

  async get(workspaceId: string, callId: string) {
    return structuredClone(this.calls.get(`${workspaceId}\u0000${callId}`)?.summary);
  }

  async getMany(workspaceId: string, callIds: readonly string[]) {
    const found = new Map<string, CallOutcomeSummary>();
    for (const callId of callIds) {
      const summary = await this.get(workspaceId, callId);
      if (summary) found.set(callId, summary);
    }
    return found;
  }

  async listEvents(workspaceId: string, callId: string, limit?: number, cursor?: string) {
    const size = eventPageLimit(limit);
    const after = eventCursor(cursor);
    const all = this.calls.get(`${workspaceId}\u0000${callId}`)?.events ?? [];
    const items = all.filter((event) => event.sequence > after).slice(0, size + 1);
    const more = items.length > size;
    if (more) items.pop();
    return {
      items: structuredClone(items),
      nextCursor: more ? String(items.at(-1)!.sequence) : null,
    };
  }

  async close() {}
}
