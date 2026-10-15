import {
  TicketContext,
  type HumanHandoffAccept,
  type HumanHandoffPort,
  type HumanHandoffRelease,
  type HumanHandoffRequest,
  type HumanHandoffTicket,
  type HumanPresence,
} from '@winsendotai/ovo-contracts';
import type { HumanQueueService, Ticket } from './service.ts';

/** A ticket opened through the port waits at most this long for an operator. */
const PORT_HOLD_MS = 15 * 60_000;

function toPortTicket(ticket: Ticket): HumanHandoffTicket {
  return {
    id: ticket.id,
    workspaceId: ticket.workspaceId,
    sessionId: ticket.sessionId,
    queueId: ticket.queueId,
    status: ticket.status,
    version: ticket.version,
    ...(ticket.assignedOperatorId ? { assignedOperatorId: ticket.assignedOperatorId } : {}),
  };
}

/** What the contract's request carries when its `context` is not a full ticket context. */
function contextOf(request: HumanHandoffRequest): TicketContext {
  const found = TicketContext.safeParse(request.context);
  if (found.success) return found.data;
  return {
    callId: request.sessionId,
    brief: request.summary.slice(0, 400),
    ...(request.summary ? { summary: request.summary.slice(0, 1_000) } : {}),
    routePath: [],
    caller: {},
    transcript: [],
    variables: {},
    returnTargets: [],
  };
}

/**
 * `HumanHandoffPort` over the human queue tables. The worker and API use `HumanQueueService`
 * directly; this adapter is the contract's own door, so anything that speaks the port (and its
 * conformance test) gets the same CAS accept, capacity and rotation rules.
 */
export class PostgresHumanHandoff implements HumanHandoffPort {
  constructor(
    private readonly service: HumanQueueService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(input: HumanHandoffRequest): Promise<HumanHandoffTicket> {
    const queue = await this.service.queues.get(input.queueId);
    if (!queue) throw new Error(`Unknown human queue ${input.queueId}`);
    const { definition } = queue;
    const created = await this.service.tickets.create({
      callId: input.sessionId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      queue: {
        id: queue.id,
        key: definition.name,
        name: definition.name,
        kind: definition.kind,
        mode: input.mode,
        teamIds: definition.kind === 'managed' ? definition.teamIds : [],
        language: definition.kind === 'managed' ? definition.language : 'ignore',
        maxWaiting: definition.limits.maxWaiting,
      },
      priority: 0,
      expiresAt: new Date(this.now().getTime() + PORT_HOLD_MS).toISOString(),
      routerAgentId: 'human-handoff-port',
      context: contextOf(input),
      contextRetentionHours: 24,
      offerSeconds: Math.max(1, Math.ceil(input.acceptTimeoutMs / 1_000)),
    });
    if (created === 'queue_full') throw new Error(`Human queue ${input.queueId} is full`);
    return toPortTicket(created);
  }

  presence(input: { workspaceId: string; queueId: string }): Promise<readonly HumanPresence[]> {
    return this.service.operators.presence(input);
  }

  async accept(input: HumanHandoffAccept): Promise<HumanHandoffTicket | { kind: 'conflict' }> {
    const result = await this.service.tickets.accept(input);
    return 'id' in result ? toPortTicket(result) : { kind: 'conflict' };
  }

  async release(input: HumanHandoffRelease): Promise<HumanHandoffTicket | { kind: 'conflict' }> {
    const result = await this.service.tickets.release({
      ...input,
      code: input.reason,
      by: 'worker',
    });
    return 'id' in result ? toPortTicket(result) : { kind: 'conflict' };
  }
}
