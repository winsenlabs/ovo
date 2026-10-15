import type { HumanQueueDefinition } from '@winsendotai/ovo-contracts';
import type { OperatorRecord, QueueRecord, TicketRow } from './rows.ts';
import type { TicketEventInput } from './service.ts';

/** Which tickets a scan returns. Ordered by service order, or by change id with `sinceChangeId`. */
export interface TicketFilter {
  queueId?: string;
  statuses?: readonly TicketRow['status'][];
  kind?: TicketRow['kind'];
  assignedTo?: string;
  callId?: string;
  idempotencyKey?: string;
  sinceChangeId?: number;
  releasedSince?: Date;
  /** Tickets whose context is due for scrubbing at this time. */
  scrubDue?: Date;
  limit?: number;
  /** Lock the rows for update, skipping any another unit holds (the sweeper). */
  lock?: boolean;
}

/** A ticket change: a value replaces the field, `null` clears it, an absent key leaves it. */
export type TicketPatch = { [K in keyof TicketRow]?: TicketRow[K] | null };

/** A unique constraint refused a write: another unit created the same ticket or call slot first. */
export class HqConflictError extends Error {
  constructor(message = 'human queue write conflict') {
    super(message);
    this.name = 'HqConflictError';
  }
}

/**
 * Everything the human-queue state machine reads and writes, inside one atomic unit. The PostgreSQL
 * store runs a unit as a transaction (rows it will change are locked `FOR UPDATE`); the in-memory
 * store runs it synchronously. The rules live once, in `HumanQueueEngine`.
 */
export interface HqTx {
  /** Serialises accepts and offers for one operator (the capacity race). */
  lockOperator(userId: string): Promise<void>;
  /** Serialises ticket creation for one call, so a call's tickets never race each other. */
  lockCall(callId: string): Promise<void>;
  operator(userId: string): Promise<OperatorRecord | undefined>;
  operators(): Promise<OperatorRecord[]>;
  putOperator(record: OperatorRecord): Promise<void>;
  /** A ticket, locked for update when the unit goes on to change it. */
  ticket(id: string, lock?: boolean): Promise<TicketRow | undefined>;
  scan(filter: TicketFilter): Promise<TicketRow[]>;
  /** Writes a new ticket and assigns `changeId`. Throws HqConflictError on a duplicate key or a second active ticket for the call. */
  insertTicket(row: Omit<TicketRow, 'changeId'>): Promise<TicketRow>;
  /** Writes the changed fields, bumping `updatedAt` and `changeId`; never `version` (the engine does). */
  updateTicket(id: string, patch: TicketPatch): Promise<TicketRow>;
  /** Without changing the change id: a heartbeat is not a state change. */
  touchTicket(id: string, patch: { workerHeartbeatAt?: Date; commandAck?: number }): Promise<void>;
  addEvent(ticketId: string, event: TicketEventInput, at: Date): Promise<'recorded' | 'duplicate'>;
  hasEvent(ticketId: string, sourceEventId: string): Promise<boolean>;
  queue(id: string): Promise<QueueRecord | undefined>;
}

export interface QueueAdmin {
  list(limit: number, cursor?: string): Promise<QueueRecord[]>;
  get(id: string): Promise<QueueRecord | undefined>;
  /** Throws HumanQueueNameTakenError. */
  insert(definition: HumanQueueDefinition, now: Date): Promise<QueueRecord>;
  update(
    id: string,
    definition: HumanQueueDefinition,
    expectedVersion: number,
    now: Date,
  ): Promise<QueueRecord | undefined>;
  /** Live point ids binding the queue. */
  usedBy(id: string): Promise<string[]>;
  softDelete(
    id: string,
    expectedVersion: number,
    now: Date,
  ): Promise<'removed' | 'conflict' | { inUseBy: string[] }>;
}

export interface HqStore {
  run<T>(work: (tx: HqTx) => Promise<T>): Promise<T>;
  readonly queues: QueueAdmin;
  /** Runs `work` only if no other caller holds the sweep lock; `undefined` when it does. */
  singleFlight<T>(name: string, work: (tx: HqTx) => Promise<T>): Promise<T | undefined>;
}
