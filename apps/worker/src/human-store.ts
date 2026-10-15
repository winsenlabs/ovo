/*
 * The ticket store as the worker uses it (human queue design 4.3, 4.5): the shapes of
 * `HumanQueueService` it reads and writes. Re-exported by `human-contract.ts`.
 */

export interface TicketContext {
  callId: string;
  brief: string;
  summary?: string;
  reason?: string;
  language?: string;
  intent?: string;
  routePath: string[];
  caller: { number?: string; calledNumber?: string };
  transcript: { role: 'caller' | 'agent'; text: string }[];
  variables: Record<string, string | number | boolean>;
  fromAgent?: { agentId: string; releaseId: string };
  returnTargets: { key: string; label: string }[];
}

export const TICKET_RELEASE_CODES = [
  'completed',
  'declined',
  'timed_out',
  'call_ended',
  'operator_no_show',
  'handed_off',
  'abandoned',
  'queue_changed',
  'worker_lost',
  'webhook_rejected',
  'webhook_failed',
  'operator_left',
  'returned',
  'ended_by_operator',
] as const;
export type TicketReleaseCode = (typeof TICKET_RELEASE_CODES)[number];

export const TICKET_OUTCOMES = [
  'connected',
  'handed_off',
  'returned',
  'ended',
  'abandoned',
  'timeout',
  'rejected',
  'unavailable',
  'failed',
  'caller_hangup',
] as const;
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];

export interface WebhookDestination {
  e164?: string;
  sipUri?: string;
  headers?: Record<string, string>;
}

export type DeskCommand = { kind: 'end_call' } | { kind: 'return_to_agent'; target: string };

export interface Ticket {
  id: string;
  workspaceId: string;
  sessionId: string;
  queueId: string;
  callId: string;
  queueKey: string;
  kind: 'external' | 'managed';
  mode: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
  status: 'waiting' | 'offered' | 'accepted' | 'released' | 'expired';
  version: number;
  priority: number;
  assignedOperatorId?: string;
  roomName?: string;
  expiresAt: string;
  connectedAt?: string;
  releaseCode?: TicketReleaseCode;
  command?: { seq: number; ack: number; body: DeskCommand };
  destination?: WebhookDestination;
  externalRef?: string;
  createdAt: string;
}

export interface NewTicket {
  callId: string;
  sessionId?: string;
  idempotencyKey: string;
  routingReleaseId?: string;
  queue: {
    id: string;
    key: string;
    name: string;
    kind: 'external' | 'managed';
    mode: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
    teamIds: readonly string[];
    language: 'ignore' | 'prefer' | 'require';
    maxWaiting: number;
  };
  priority: number;
  language?: string;
  callerMasked?: string;
  expiresAt: string;
  routerAgentId: string;
  credentialId?: string;
  callbackUntil?: string;
  context: TicketContext;
  contextRetentionHours: number;
  offerSeconds?: number;
}

export type TicketCreated = Ticket | 'queue_full' | { kind: 'duplicate'; ticket: Ticket };

/** What the worker uses of `HumanQueueService` (a structural subset of core's full interface). */
export interface HumanQueuePort {
  readonly enabled: boolean;
  queues?: { stats(id: string): Promise<{ waiting: number; offered: number }> };
  operators: {
    availability(
      queue: {
        queueId: string;
        teamIds: readonly string[];
        language: 'ignore' | 'prefer' | 'require';
      },
      language?: string,
    ): Promise<{ online: number; withRoom: number }>;
  };
  tickets: {
    create(input: NewTicket): Promise<TicketCreated>;
    get(id: string): Promise<Ticket | undefined>;
    release(input: {
      workspaceId: string;
      ticketId: string;
      expectedVersion: number;
      reason: 'completed' | 'declined' | 'timed_out' | 'call_ended';
      idempotencyKey: string;
      code: TicketReleaseCode;
      by: 'worker' | 'operator' | 'sweeper' | 'admin' | 'callback';
    }): Promise<Ticket | { kind: 'conflict' }>;
    reoffer(
      id: string,
      expectedVersion: number,
      code: 'operator_no_show',
    ): Promise<Ticket | { kind: 'conflict' }>;
    workerBeat(id: string): Promise<void>;
    ackCommand(id: string, seq: number): Promise<void>;
    markHandedOff(id: string): Promise<void>;
    appendEvent(
      id: string,
      event: { kind: string; sourceEventId?: string; payload: Record<string, unknown> },
    ): Promise<'recorded' | 'duplicate'>;
    issueContextToken(id: string, ttlSeconds: number): Promise<string>;
  };
}
