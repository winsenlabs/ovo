import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import {
  CapacityController,
  OutboxPublisher,
  type CapacityInput,
  type CapacityLeaseStore,
  type DesiredCountWriter,
  type DurableQueue,
  type PostgresOrchestrationStore,
} from '@winsendotai/ovo-plugin-orchestration';

export class DispatcherService {
  readonly outbox: OutboxPublisher;
  readonly capacity: CapacityController;

  constructor(input: {
    dispatcherId: string;
    store: PostgresOrchestrationStore & CapacityLeaseStore;
    queue: DurableQueue;
    writer: DesiredCountWriter;
    serviceKey?: string;
    leaderLeaseMs?: number;
  }) {
    this.outbox = new OutboxPublisher(input.dispatcherId, input.store, input.queue);
    this.capacity = new CapacityController(
      input.serviceKey ?? 'workers',
      input.leaderLeaseMs ?? 15_000,
      input.store,
      input.writer,
    );
  }

  flushOutbox(limit?: number): Promise<{ sent: number; failed: number }> {
    return this.outbox.flush(limit);
  }

  decideAndApplyCapacity(input: CapacityInput) {
    return this.capacity.tick(input);
  }
}

export const dispatcherPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-dispatcher/service',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: ['orchestration.store', 'orchestration.queue', 'capacity.writer'],
    provides: ['dispatcher.service'],
    configSchema: {
      type: 'object',
      required: ['dispatcherId'],
      properties: { dispatcherId: { type: 'string' }, serviceKey: { type: 'string' } },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    if (typeof config.dispatcherId !== 'string' || !config.dispatcherId)
      throw new Error('Missing dispatcherId');
    ctx.provide(
      'dispatcher.service',
      new DispatcherService({
        dispatcherId: config.dispatcherId,
        store: ctx.get('orchestration.store') as PostgresOrchestrationStore,
        queue: ctx.get('orchestration.queue') as DurableQueue,
        writer: ctx.get('capacity.writer') as DesiredCountWriter,
        serviceKey: typeof config.serviceKey === 'string' ? config.serviceKey : 'workers',
      }),
    );
  },
);
