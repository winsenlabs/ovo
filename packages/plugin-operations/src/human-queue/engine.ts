import { QueueAndOperatorEngine } from './operators.ts';
import type { HumanQueueService, SweepResult } from './service.ts';
import type { HqStore } from './store.ts';
import { sweepOnce } from './sweep.ts';
import { TicketSupport } from './ticket-support.ts';
import { TicketViews } from './ticket-views.ts';
import { TicketLifecycle } from './tickets.ts';
import { defaultContext, type EngineContext } from './transitions.ts';

export interface HumanQueueEngineOptions {
  organizationId: string;
  enabled?: boolean;
  /** Fake clock in tests. */
  now?: () => Date;
  presenceTtlSeconds?: number;
}

/** The human-queue rules once, over any `HqStore` (memory for unit tests, PostgreSQL in production). */
export class HumanQueueEngine implements HumanQueueService {
  readonly enabled: boolean;
  readonly queues: HumanQueueService['queues'];
  readonly operators: HumanQueueService['operators'];
  readonly tickets: HumanQueueService['tickets'];
  private readonly ctx: EngineContext;

  constructor(
    private readonly store: HqStore,
    options: HumanQueueEngineOptions,
  ) {
    this.enabled = options.enabled === true;
    this.ctx = {
      ...defaultContext(options.organizationId, options.now ?? (() => new Date())),
      ...(options.presenceTtlSeconds ? { presenceTtlSeconds: options.presenceTtlSeconds } : {}),
    };
    const admin = new QueueAndOperatorEngine(store, this.ctx);
    const tickets = new TicketLifecycle(store, this.ctx);
    const views = new TicketViews(store, this.ctx);
    const support = new TicketSupport(store, this.ctx);
    this.queues = admin.queues;
    this.operators = admin.operators;
    this.tickets = {
      create: (input) => tickets.create(input),
      get: (id) => tickets.get(id),
      listForOperator: (userId, scope) => views.listForOperator(userId, scope),
      changes: (since, userId) => views.changes(since, userId),
      head: () => store.run((tx) => tx.headChangeId()),
      roomsToClose: (limit) => support.roomsToClose(limit),
      accept: (input) => tickets.accept(input),
      decline: (input) => tickets.decline(input),
      release: (input) => tickets.release(input),
      reoffer: (id, version, code) => tickets.reoffer(id, version, code),
      workerBeat: (id) => support.workerBeat(id),
      markConnected: (id) => support.markConnected(id),
      setCommand: (id, operatorId, command) => support.setCommand(id, operatorId, command),
      ackCommand: (id, seq) => support.ackCommand(id, seq),
      setDestination: (id, source, destination, ref) =>
        support.setDestination(id, source, destination, ref),
      markHandedOff: (id) => tickets.markHandedOff(id),
      setWrapUp: (id, operatorId, wrap) => support.setWrapUp(id, operatorId, wrap),
      appendEvent: (id, event) => support.appendEvent(id, event),
      context: (id, who) => support.context(id, who),
      issueContextToken: (id, ttl) => support.issueContextToken(id, ttl),
    };
  }

  sweep(now: Date): Promise<SweepResult> {
    return sweepOnce(this.store, this.ctx, now);
  }
}
