import { randomUUID } from 'node:crypto';
import { HumanQueueEngine, type HumanQueueEngineOptions } from './engine.ts';
import { byService } from './rules.ts';
import type { OperatorRecord, QueueRecord, TicketRow } from './rows.ts';
import { HumanQueueNameTakenError, type TicketEventInput } from './service.ts';
import { applyPatch, matches, MemoryClock } from './memory-support.ts';
import {
  HqConflictError,
  type HqStore,
  type HqTx,
  type QueueAdmin,
  type TicketPatch,
} from './store.ts';

interface Snapshot {
  tickets: Map<string, TicketRow>;
  operators: Map<string, OperatorRecord>;
  queues: Map<string, QueueRecord>;
  events: Map<
    string,
    { sourceEventId?: string; kind: string; at: Date; payload: Record<string, unknown> }[]
  >;
  changeSeq: number;
}

/** The in-memory store: units run one at a time and roll back on error, like a transaction. */
export { MemoryClock };

export class MemoryHqStore implements HqStore {
  private state: Snapshot = {
    tickets: new Map(),
    operators: new Map(),
    queues: new Map(),
    events: new Map(),
    changeSeq: 0,
  };
  /** point id -> queue ids its draft binds (a live point). */
  readonly points = new Map<string, readonly string[]>();
  private tail: Promise<unknown> = Promise.resolve();
  private sweeping = false;

  constructor(private readonly now: () => Date) {}

  run<T>(work: (tx: HqTx) => Promise<T>): Promise<T> {
    const turn = this.tail.then(async () => {
      const backup: Snapshot = {
        tickets: new Map(this.state.tickets),
        operators: new Map(this.state.operators),
        queues: new Map(this.state.queues),
        events: new Map([...this.state.events].map(([id, list]) => [id, [...list]])),
        changeSeq: this.state.changeSeq,
      };
      try {
        return await work(this.tx());
      } catch (error) {
        this.state = backup;
        throw error;
      }
    });
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  async singleFlight<T>(_name: string, work: (tx: HqTx) => Promise<T>): Promise<T | undefined> {
    if (this.sweeping) return undefined;
    this.sweeping = true;
    try {
      return await this.run(work);
    } finally {
      this.sweeping = false;
    }
  }

  readonly queues: QueueAdmin = {
    list: async (limit, cursor) =>
      [...this.state.queues.values()]
        .filter((q) => !q.deletedAt && (cursor === undefined || q.id > cursor))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit),
    get: async (id) => this.state.queues.get(id),
    insert: async (definition, at) => {
      this.requireFreeName(definition.name);
      const record: QueueRecord = {
        id: randomUUID(),
        name: definition.name,
        kind: definition.kind,
        definition,
        teamIds: definition.kind === 'managed' ? [...definition.teamIds] : [],
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      this.state.queues.set(record.id, record);
      return record;
    },
    update: async (id, definition, expectedVersion, at) => {
      const found = this.state.queues.get(id);
      if (!found || found.deletedAt || found.version !== expectedVersion) return undefined;
      this.requireFreeName(definition.name, id);
      const next: QueueRecord = {
        ...found,
        name: definition.name,
        kind: definition.kind,
        definition,
        teamIds: definition.kind === 'managed' ? [...definition.teamIds] : [],
        version: found.version + 1,
        updatedAt: at,
      };
      this.state.queues.set(id, next);
      return next;
    },
    usedBy: async (id) => this.usersOf(id),
    softDelete: async (id, expectedVersion, at) => {
      const found = this.state.queues.get(id);
      if (!found || found.deletedAt || found.version !== expectedVersion) return 'conflict';
      const inUseBy = this.usersOf(id);
      if (inUseBy.length) return { inUseBy };
      this.state.queues.set(id, { ...found, deletedAt: at, updatedAt: at });
      return 'removed';
    },
  };

  private usersOf(queueId: string): string[] {
    return [...this.points]
      .filter(([, ids]) => ids.includes(queueId))
      .map(([id]) => id)
      .sort();
  }

  private requireFreeName(name: string, except?: string): void {
    for (const queue of this.state.queues.values())
      if (
        !queue.deletedAt &&
        queue.id !== except &&
        queue.name.toLowerCase() === name.toLowerCase()
      )
        throw new HumanQueueNameTakenError(name);
  }

  private tx(): HqTx {
    const state = () => this.state;
    return {
      lockOperator: async () => undefined,
      lockCall: async () => undefined,
      operator: async (userId) => state().operators.get(userId),
      operators: async () =>
        [...state().operators.values()].sort((a, b) => a.userId.localeCompare(b.userId)),
      putOperator: async (record) => void state().operators.set(record.userId, record),
      ticket: async (id) => state().tickets.get(id),
      scan: async (filter) => {
        const found = [...state().tickets.values()].filter(
          (row) =>
            matches(row, filter) &&
            (!filter.roomOpen ||
              (row.roomName !== undefined &&
                !(state().events.get(row.id) ?? []).some((e) => e.kind === 'room_closed'))),
        );
        found.sort(
          filter.sinceChangeId === undefined ? byService : (a, b) => a.changeId - b.changeId,
        );
        return filter.limit === undefined ? found : found.slice(0, filter.limit);
      },
      headChangeId: async () => state().changeSeq,
      insertTicket: async (row) => {
        for (const other of state().tickets.values()) {
          if (other.idempotencyKey === row.idempotencyKey) throw new HqConflictError();
          if (
            other.callId === row.callId &&
            ['waiting', 'offered', 'accepted'].includes(other.status) &&
            ['waiting', 'offered', 'accepted'].includes(row.status)
          )
            throw new HqConflictError();
        }
        const created: TicketRow = { ...row, changeId: ++state().changeSeq };
        state().tickets.set(created.id, created);
        return created;
      },
      updateTicket: async (id, patch: TicketPatch) => {
        const found = state().tickets.get(id);
        if (!found) throw new Error('Unknown human queue ticket');
        const next = applyPatch(found, {
          ...patch,
          updatedAt: this.now(),
          changeId: ++state().changeSeq,
        });
        state().tickets.set(id, next);
        return next;
      },
      touchTicket: async (id, patch) => {
        const found = state().tickets.get(id);
        if (found) state().tickets.set(id, applyPatch(found, patch));
      },
      addEvent: async (ticketId, event: TicketEventInput, at) => {
        const list = state().events.get(ticketId) ?? [];
        if (event.sourceEventId && list.some((e) => e.sourceEventId === event.sourceEventId))
          return 'duplicate';
        list.push({
          kind: event.kind,
          at,
          payload: event.payload,
          ...(event.sourceEventId ? { sourceEventId: event.sourceEventId } : {}),
        });
        state().events.set(ticketId, list);
        return 'recorded';
      },
      hasEvent: async (ticketId, sourceEventId) =>
        (state().events.get(ticketId) ?? []).some((e) => e.sourceEventId === sourceEventId),
      queue: async (id) => state().queues.get(id),
    };
  }

  /** Test reading: the events a ticket has, oldest first. */
  eventsOf(
    ticketId: string,
  ): { kind: string; sourceEventId?: string; payload: Record<string, unknown> }[] {
    return (this.state.events.get(ticketId) ?? []).map(({ kind, sourceEventId, payload }) => ({
      kind,
      payload,
      ...(sourceEventId ? { sourceEventId } : {}),
    }));
  }
}

/**
 * The same service as PostgreSQL's, in memory, with a fake clock: for unit tests of the worker and
 * API lanes. `bindPoint` stands in for the routing point link table.
 */
export class InMemoryHumanQueueService extends HumanQueueEngine {
  readonly clock: MemoryClock;
  readonly memory: MemoryHqStore;

  constructor(options: Partial<HumanQueueEngineOptions> & { clock?: MemoryClock } = {}) {
    const clock = options.clock ?? new MemoryClock();
    const store = new MemoryHqStore(options.now ?? clock.now);
    super(store, {
      organizationId: options.organizationId ?? 'org',
      enabled: options.enabled ?? true,
      now: options.now ?? clock.now,
      ...(options.presenceTtlSeconds ? { presenceTtlSeconds: options.presenceTtlSeconds } : {}),
    });
    this.clock = clock;
    this.memory = store;
  }

  /** A live routing point whose draft binds these queues (none: the point is gone). */
  bindPoint(pointId: string, queueIds: readonly string[] | undefined): void {
    if (queueIds) this.memory.points.set(pointId, queueIds);
    else this.memory.points.delete(pointId);
  }
}
