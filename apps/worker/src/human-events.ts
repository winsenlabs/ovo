import type { TicketOutcome, TicketReleaseCode } from './human-contract.ts';

/*
 * The four `human.*` session events (human queue design 4.7): ids, keys, codes and timings only.
 * Never the caller's words or number, a summary, a destination or a header; those live in the
 * ticket row and nowhere else.
 */

type Payload = Record<string, unknown>;
export type HumanSource = 'router' | 'llm' | 'flow' | 'fallback' | 'chain';

export interface QueueRef {
  key: string;
  id: string;
  kind: 'external' | 'managed';
}

export function humanRequested(
  queue: QueueRef,
  input: {
    source: HumanSource;
    result: 'accepted' | 'refused';
    refusal?: string;
    ticket?: string;
    priority?: number;
    transfer?: number;
  },
): Payload {
  return {
    ...{ queue: queue.key, queueId: queue.id, kind: queue.kind, source: input.source },
    result: input.result,
    ...(input.refusal ? { refusal: input.refusal } : {}),
    ...(input.ticket ? { ticket: input.ticket } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.transfer !== undefined ? { transfer: input.transfer } : {}),
  };
}

export type HumanState =
  | 'waiting'
  | 'offered'
  | 'accepted'
  | 'connected'
  | 'released'
  | 'expired'
  | 'destination'
  | 'handed_off';

export function humanState(
  ticket: string,
  state: HumanState,
  input: {
    version?: number;
    by: 'worker' | 'operator' | 'sweeper' | 'callback' | 'admin';
    operator?: string;
    code?: TicketReleaseCode | string;
    waitMs?: number;
  },
): Payload {
  return {
    ticket,
    state,
    by: input.by,
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.operator ? { operator: input.operator } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.waitMs !== undefined ? { waitMs: Math.max(0, Math.round(input.waitMs)) } : {}),
  };
}

export function humanWebhook(
  ticket: string,
  input: {
    attempt: number;
    outcome:
      'delivered' | 'retry' | 'failed' | 'accepted' | 'queued' | 'rejected' | 'cancelled_sent';
    status?: number;
    ms: number;
    reason?: string;
  },
): Payload {
  return {
    ticket,
    attempt: input.attempt,
    outcome: input.outcome,
    ms: Math.max(0, Math.round(input.ms)),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 80) } : {}),
  };
}

export function humanCompleted(
  queue: QueueRef,
  input: {
    ticket: string;
    outcome: TicketOutcome;
    waitMs: number;
    talkMs?: number;
    operator?: string;
    segment?: number;
    steps?: readonly string[];
  },
): Payload {
  return {
    ticket: input.ticket,
    queue: queue.key,
    kind: queue.kind,
    outcome: input.outcome,
    waitMs: Math.max(0, Math.round(input.waitMs)),
    ...(input.talkMs !== undefined ? { talkMs: Math.max(0, Math.round(input.talkMs)) } : {}),
    ...(input.operator ? { operator: input.operator } : {}),
    ...(input.segment !== undefined ? { segment: input.segment } : {}),
    ...(input.steps?.length ? { steps: input.steps.slice(0, 8) } : {}),
  };
}

/** The outcome a release code stands for, for `human.completed`. */
export function outcomeOfRelease(code: TicketReleaseCode | string): TicketOutcome {
  switch (code) {
    case 'handed_off':
      return 'handed_off';
    case 'returned':
      return 'returned';
    case 'completed':
    case 'ended_by_operator':
    case 'operator_left':
      return 'ended';
    case 'call_ended':
      return 'caller_hangup';
    case 'webhook_rejected':
      return 'rejected';
    case 'webhook_failed':
      return 'unavailable';
    case 'timed_out':
    case 'operator_no_show':
      return 'timeout';
    case 'abandoned':
    case 'queue_changed':
      return 'abandoned';
    default:
      return 'failed';
  }
}
