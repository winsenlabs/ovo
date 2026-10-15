import type {
  DeskCommand,
  HumanQueuePort,
  NewTicket,
  Ticket,
  TicketReleaseCode,
  WebhookDestination,
} from '../src/human-contract.ts';

/** The ticket store as the worker uses it: the same transitions the real service guards. */
export class FakeHumanService implements HumanQueuePort {
  readonly enabled = true;
  readonly all = new Map<string, Ticket>();
  readonly created: NewTicket[] = [];
  readonly events: { id: string; kind: string; payload: Record<string, unknown> }[] = [];
  readonly beats: string[] = [];
  readonly acks: number[] = [];
  readonly handedOff: string[] = [];
  readonly releases: { id: string; code: TicketReleaseCode }[] = [];
  available = { online: 1, withRoom: 1 };
  waiting = 0;
  failCreate = false;
  createAnswer?: 'queue_full';
  private n = 0;
  private readonly keys = new Map<string, string>();

  queues = { stats: async () => ({ waiting: this.waiting, offered: 0 }) };
  operators = { availability: async () => this.available };
  tickets: HumanQueuePort['tickets'] = {
    create: async (input) => {
      if (this.failCreate) throw new Error('storage down');
      if (this.createAnswer) return this.createAnswer;
      this.created.push(input);
      const existing = this.all.get(this.keys.get(input.idempotencyKey) ?? '');
      if (existing) return { kind: 'duplicate', ticket: existing };
      const ticket: Ticket = {
        id: `ticket-${++this.n}`,
        workspaceId: 'ws-1',
        sessionId: input.sessionId ?? 'session-1',
        queueId: input.queue.id,
        callId: input.callId,
        queueKey: input.queue.key,
        kind: input.queue.kind,
        mode: input.queue.mode,
        status: 'waiting',
        version: 1,
        priority: input.priority,
        expiresAt: input.expiresAt,
        createdAt: new Date(0).toISOString(),
      };
      this.all.set(ticket.id, ticket);
      this.keys.set(input.idempotencyKey, ticket.id);
      return ticket;
    },
    get: async (id) => this.all.get(id),
    release: async (input) => {
      const ticket = this.all.get(input.ticketId);
      if (!ticket || ticket.version !== input.expectedVersion) return { kind: 'conflict' };
      this.releases.push({ id: ticket.id, code: input.code });
      return this.patch(ticket, { status: 'released', releaseCode: input.code });
    },
    reoffer: async (id, expectedVersion) => {
      const ticket = this.all.get(id);
      if (!ticket || ticket.version !== expectedVersion) return { kind: 'conflict' };
      return this.patch(ticket, {
        status: 'waiting',
        assignedOperatorId: undefined,
        roomName: undefined,
      });
    },
    workerBeat: async (id) => void this.beats.push(id),
    ackCommand: async (id, seq) => {
      this.acks.push(seq);
      const ticket = this.all.get(id);
      if (ticket?.command) ticket.command = { ...ticket.command, ack: seq };
    },
    markHandedOff: async (id) => void this.handedOff.push(id),
    appendEvent: async (id, event) => {
      this.events.push({ id, ...event });
      return 'recorded';
    },
    issueContextToken: async () => 'ctx-token',
  };

  private patch(ticket: Ticket, over: Partial<Ticket>): Ticket {
    const next = { ...ticket, ...over, version: ticket.version + 1 };
    this.all.set(ticket.id, next);
    return next;
  }

  first(): Ticket {
    return [...this.all.values()][0]!;
  }

  /** An operator accepts: the API's accept, which also opens the room. */
  accept(id: string, operatorId = 'ana'): Ticket {
    return this.patch(this.all.get(id)!, {
      status: 'accepted',
      assignedOperatorId: operatorId,
      roomName: `ovo-hq-${id}`,
    });
  }

  /** The signed callback wrote the answered destination. */
  destination(id: string, destination: WebhookDestination): void {
    this.patch(this.all.get(id)!, { destination });
  }

  command(id: string, body: DeskCommand): number {
    const ticket = this.all.get(id)!;
    const seq = (ticket.command?.seq ?? 0) + 1;
    this.patch(ticket, { command: { seq, ack: ticket.command?.ack ?? 0, body } });
    return seq;
  }

  /** Someone else (the sweeper, an admin) ended it. */
  end(id: string, status: 'released' | 'expired', code?: TicketReleaseCode): void {
    this.patch(this.all.get(id)!, { status, ...(code ? { releaseCode: code } : {}) });
  }
}
