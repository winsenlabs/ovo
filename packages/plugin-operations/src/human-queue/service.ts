import type {
  DeskCommand,
  HumanHandoffAccept,
  HumanHandoffRelease,
  HumanHandoffTicket,
  HumanPresence,
  HumanQueue,
  HumanQueueDefinition,
  HumanTicketView,
  OperatorProfile,
  OperatorStatus,
  TicketContext,
  TicketOutcome,
  TicketReleaseCode,
  WebhookDestination,
  WrapUp,
} from '@winsendotai/ovo-contracts';

/**
 * Wave 17 (R3) human-queue storage (design 4.5), organization-scoped: the port the worker (which
 * holds the call), the API (which serves operators) and the dispatcher's sweeper share. They meet
 * in the ticket row, never directly.
 */
export type { OperatorStatus, TicketReleaseCode };

export interface ManagedQueueRef {
  queueId: string;
  teamIds: readonly string[];
  language: 'ignore' | 'prefer' | 'require';
}
export type { WebhookDestination };

export type TicketStatus = HumanHandoffTicket['status'];
export interface NewTicket {
  callId: string;
  sessionId?: string;
  /** `hq:<org>:<callId>:<n>`: the same on every retry of one handoff. */
  idempotencyKey: string;
  routingReleaseId?: string;
  queue: {
    id: string;
    key: string;
    name: string;
    kind: 'external' | 'managed';
    mode: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
    teamIds: readonly string[];
    language: ManagedQueueRef['language'];
    maxWaiting: number;
  };
  priority: number;
  language?: string;
  callerMasked?: string;
  /** The hold's deadline; the sweeper expires a waiting ticket past it. */
  expiresAt: string;
  routerAgentId: string;
  credentialId?: string;
  /** External: callbacks are accepted until then. */
  callbackUntil?: string;
  context: TicketContext;
  /** Hours after the ticket ends that `context` is kept (0: scrubbed at the end). */
  contextRetentionHours: number;
  /** AUTO_ASSIGN offer expiry in seconds (default 20). */
  offerSeconds?: number;
}

/** The contract's ticket plus the rows the worker and API need. */
export interface Ticket extends HumanHandoffTicket {
  callId: string;
  queueKey: string;
  queueName: string;
  kind: 'external' | 'managed';
  mode: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
  priority: number;
  language?: string;
  roomName?: string;
  offerExpiresAt?: string;
  expiresAt: string;
  acceptedAt?: string;
  connectedAt?: string;
  releasedAt?: string;
  releaseCode?: TicketReleaseCode;
  outcome?: TicketOutcome;
  command?: { seq: number; ack: number; body: DeskCommand };
  destination?: WebhookDestination;
  externalRef?: string;
  routerAgentId?: string;
  credentialId?: string;
  callbackUntil?: string;
  wrapUp?: WrapUp;
  createdAt: string;
  /** True on the result of a `create` that matched an existing idempotency key. */
  duplicate?: true;
}

export type OperatorRow = OperatorProfile & {
  status: OperatorStatus;
  lastSeenAt?: string;
  /** Tickets this operator has accepted and not released. */
  active: number;
};

export interface QueueStats {
  waiting: number;
  offered: number;
  oldestWaitMs: number;
  online: number;
  handled24h: number;
}

export type TicketEventInput = {
  kind: string;
  sourceEventId?: string;
  payload: Record<string, unknown>;
};

export class HumanQueueNameTakenError extends Error {
  readonly code = 'human_queue_name_taken';
  constructor(name: string) {
    super(`A human queue named ${JSON.stringify(name)} already exists`);
    this.name = 'HumanQueueNameTakenError';
  }
}

export interface SweepResult {
  /** Waiting tickets offered to an operator (AUTO_ASSIGN). */
  assigned: number;
  /** Tickets past their deadline, moved to `expired`. */
  expired: number;
  /** Offers that lapsed and went back to `waiting`. */
  reoffered: number;
  /** Tickets whose context was scrubbed. */
  scrubbed: number;
  /** Active tickets whose worker stopped beating, released `worker_lost`. */
  stale: number;
}

export interface HumanQueueService {
  /** OVO_HUMAN_QUEUE_ENABLED. */
  readonly enabled: boolean;
  queues: {
    /** Ordered by id. */
    list(limit: number, cursor?: string): Promise<HumanQueue[]>;
    get(
      id: string,
      options?: { includeDeleted?: boolean },
    ): Promise<(HumanQueue & { deletedAt?: string }) | undefined>;
    /** Throws HumanQueueNameTakenError when an active queue has the name (case-insensitive). */
    create(definition: HumanQueueDefinition): Promise<HumanQueue>;
    /** Undefined = missing or conflict. */
    update(
      id: string,
      definition: HumanQueueDefinition,
      expectedVersion: number,
    ): Promise<HumanQueue | undefined>;
    remove(
      id: string,
      expectedVersion: number,
    ): Promise<'removed' | 'conflict' | { inUseBy: string[] }>;
    /** Live point ids whose current draft binds the queue. */
    usedBy(id: string): Promise<string[]>;
    stats(id: string): Promise<QueueStats>;
  };
  operators: {
    list(): Promise<OperatorRow[]>;
    get(userId: string): Promise<OperatorProfile | undefined>;
    /** Profile only; presence is `heartbeat`. */
    upsert(profile: OperatorProfile): Promise<void>;
    /** Refreshes presence; a disabled or unknown operator stays OFFLINE and nothing is written. */
    heartbeat(userId: string, status?: OperatorStatus): Promise<{ status: OperatorStatus }>;
    /** The precheck: eligible operators online, and of those how many have room. */
    availability(
      queue: ManagedQueueRef,
      language?: string,
    ): Promise<{ online: number; withRoom: number }>;
    presence(input: { workspaceId: string; queueId: string }): Promise<readonly HumanPresence[]>;
  };
  tickets: {
    /**
     * Idempotent by `idempotencyKey` (the existing ticket comes back, `duplicate: true`). Opens one
     * ticket per call: any other active ticket of the call is released `queue_changed` in the same
     * transaction. An AUTO_ASSIGN ticket is offered once inline.
     */
    create(input: NewTicket): Promise<Ticket | 'queue_full'>;
    get(id: string): Promise<Ticket | undefined>;
    listForOperator(userId: string, scope: 'queue' | 'mine'): Promise<HumanTicketView[]>;
    /** Tickets changed after `sinceChangeId` in the operator's domain, any status, oldest change first. */
    changes(
      sinceChangeId: number,
      userId: string,
    ): Promise<{ items: HumanTicketView[]; cursor: number }>;
    /** Compare-and-set on `expectedVersion`; the first of concurrent operators wins. */
    accept(
      input: HumanHandoffAccept,
    ): Promise<Ticket | { kind: 'conflict' | 'not_eligible' | 'at_capacity' }>;
    decline(input: {
      ticketId: string;
      operatorId: string;
      expectedVersion: number;
    }): Promise<Ticket | { kind: 'conflict' }>;
    /** Idempotent on a ticket that already ended; a stale version on an active one conflicts. */
    release(
      input: HumanHandoffRelease & {
        code: TicketReleaseCode;
        by: 'worker' | 'operator' | 'sweeper' | 'admin' | 'callback';
        outcome?: TicketOutcome;
      },
    ): Promise<Ticket | { kind: 'conflict' }>;
    /** accepted -> waiting: the operator never joined. The operator joins `declined_by`. */
    reoffer(
      id: string,
      expectedVersion: number,
      code: 'operator_no_show',
    ): Promise<Ticket | { kind: 'conflict' }>;
    /** The worker holding the call, every 5 s; no beat for 20 s and the sweeper releases `worker_lost`. */
    workerBeat(id: string): Promise<void>;
    /** The operator is in the room with the caller. */
    markConnected(id: string): Promise<void>;
    /** The assigned operator's command; the latest wins. Returns its sequence number. */
    setCommand(
      id: string,
      operatorId: string,
      command: DeskCommand,
    ): Promise<number | 'forbidden' | 'conflict'>;
    ackCommand(id: string, seq: number): Promise<void>;
    /** One destination per ticket: false when it already has one or is no longer open. */
    setDestination(
      id: string,
      source: 'sync' | 'callback',
      destination: WebhookDestination,
      externalRef?: string,
    ): Promise<boolean>;
    /** The leg left OVO for a third party: released `handed_off`. Idempotent. */
    markHandedOff(id: string): Promise<void>;
    setWrapUp(id: string, operatorId: string, wrap: WrapUp): Promise<boolean>;
    appendEvent(id: string, event: TicketEventInput): Promise<'recorded' | 'duplicate'>;
    context(
      id: string,
      who: { operatorId: string } | { token: string },
    ): Promise<TicketContext | 'forbidden' | 'expired' | undefined>;
    /** Stores a hash; returns the bearer a third party fetches the context with. */
    issueContextToken(id: string, ttlSeconds: number): Promise<string>;
  };
  /** One sweeper pass (single flight): assign, expire offers and deadlines, stale workers, scrub. */
  sweep(now: Date): Promise<SweepResult>;
}
