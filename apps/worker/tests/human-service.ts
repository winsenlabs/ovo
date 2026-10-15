import type { HumanQueueService } from '@winsendotai/ovo-plugin-operations';
import { InMemoryHumanQueueService } from '@winsendotai/ovo-plugin-operations/testing';
import type {
  DeskCommand,
  HumanQueuePort,
  NewTicket,
  Ticket,
  TicketReleaseCode,
  WebhookDestination,
} from '../src/human-contract.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_RELEASE = '00000000-0000-4000-8000-000000000a01';

/**
 * The shared ticket store a worker test runs against: core's real in-memory service (its state
 * machine, eligibility and idempotency), with the few doors a test needs. `available`, `waiting`,
 * `failCreate` and `createAnswer` stand in for the live staffing and storage a unit test does
 * not set up; everything else is the service's own behaviour. What the worker did to it is kept
 * in `created`, `releases`, `beats`, `acks` and `handedOff`.
 */
export class FakeHumanService implements HumanQueuePort {
  readonly enabled = true;
  readonly real: HumanQueueService;
  readonly created: NewTicket[] = [];
  /** The ids of the tickets the worker created, in order (they are uuids). */
  readonly ids: string[] = [];
  /** Errors the store threw on create (the worker turns them into a code). */
  readonly failures: string[] = [];
  readonly releases: { id: string; code: TicketReleaseCode }[] = [];
  readonly beats: string[] = [];
  readonly acks: number[] = [];
  readonly handedOff: string[] = [];
  available: { online: number; withRoom: number } | 'real' = { online: 1, withRoom: 1 };
  waiting: number | undefined;
  failCreate = false;
  createAnswer?: 'queue_full';
  readonly queues: HumanQueuePort['queues'];
  readonly operators: HumanQueuePort['operators'];
  readonly tickets: HumanQueuePort['tickets'];

  /** `store`: any real service (PostgreSQL); by default core's in-memory one on `now`. */
  constructor(now: () => Date, organizationId = 'ws-1', store?: HumanQueueService) {
    const real = (this.real =
      store ?? new InMemoryHumanQueueService({ organizationId, enabled: true, now }));
    const tickets = real.tickets;
    this.queues = {
      stats: async (id) =>
        this.waiting === undefined
          ? real.queues.stats(id)
          : { waiting: this.waiting, offered: 0, oldestWaitMs: 0, online: 0, handled24h: 0 },
    };
    this.operators = {
      availability: async (queue, language) =>
        this.available === 'real' ? real.operators.availability(queue, language) : this.available,
    };
    this.tickets = {
      ...tickets,
      create: async (input) => {
        if (this.failCreate) throw new Error('storage down');
        if (this.createAnswer) return this.createAnswer;
        this.created.push(input);
        // The harness names releases 'release-a'; a stored context holds real (uuid) release ids.
        const from = input.context.fromAgent;
        const stored =
          from && !UUID.test(from.releaseId)
            ? {
                ...input,
                context: { ...input.context, fromAgent: { ...from, releaseId: TEST_RELEASE } },
              }
            : input;
        const made = await tickets.create(stored).catch((error: unknown) => {
          this.failures.push(String(error));
          throw error;
        });
        if (made !== 'queue_full' && !made.duplicate) this.ids.push(made.id);
        return made;
      },
      release: async (input) => {
        const released = await tickets.release(input);
        if (!('kind' in released) || released.kind !== 'conflict')
          this.releases.push({ id: input.ticketId, code: input.code });
        return released;
      },
      workerBeat: async (id) => {
        this.beats.push(id);
        return tickets.workerBeat(id);
      },
      ackCommand: async (id, seq) => {
        this.acks.push(seq);
        return tickets.ackCommand(id, seq);
      },
      markHandedOff: async (id) => {
        this.handedOff.push(id);
        return tickets.markHandedOff(id);
      },
    };
  }

  /** The id of the `n`th ticket (1-based) the worker created. */
  id(n = 1): string {
    const id = this.ids[n - 1];
    if (!id) throw new Error(`no ticket ${n} yet (${this.ids.length} created)`);
    return id;
  }

  async ticket(id: string): Promise<Ticket> {
    return (await this.real.tickets.get(id))!;
  }

  /** The operator `operatorId` (online, with room) accepts ticket `id`: the API's accept. */
  async accept(id: string, operatorId = 'ana'): Promise<Ticket> {
    await this.real.operators.upsert({
      userId: operatorId,
      displayName: operatorId,
      enabled: true,
      teamIds: [],
      languages: [],
      capacity: 5,
    });
    await this.real.operators.heartbeat(operatorId, 'AVAILABLE');
    const ticket = await this.ticket(id);
    const accepted = await this.real.tickets.accept({
      workspaceId: ticket.workspaceId,
      ticketId: id,
      operatorId,
      expectedVersion: ticket.version,
      idempotencyKey: `accept:${id}:${operatorId}:${ticket.version}`,
    });
    if (!('status' in accepted)) throw new Error(`accept refused: ${accepted.kind}`);
    return accepted;
  }

  /** The signed callback wrote the answered destination. */
  async destination(id: string, destination: WebhookDestination): Promise<boolean> {
    return this.real.tickets.setDestination(id, 'callback', destination);
  }

  /** The assigned operator's command, as the API stores it. */
  async command(id: string, body: DeskCommand): Promise<number> {
    const ticket = await this.ticket(id);
    const seq = await this.real.tickets.setCommand(id, ticket.assignedOperatorId!, body);
    if (typeof seq !== 'number') throw new Error(`command refused: ${seq}`);
    return seq;
  }

  /** Someone else (an admin, the sweeper) ended it. */
  async end(id: string, status: 'released' | 'expired', code?: TicketReleaseCode): Promise<void> {
    const ticket = await this.ticket(id);
    if (status === 'released') {
      await this.real.tickets.release({
        workspaceId: ticket.workspaceId,
        ticketId: id,
        expectedVersion: ticket.version,
        reason: 'completed',
        idempotencyKey: `end:${id}`,
        code: code ?? 'operator_left',
        by: 'admin',
      });
      return;
    }
    await this.real.sweep(new Date(new Date(ticket.expiresAt).getTime() + 1_000));
  }
}
