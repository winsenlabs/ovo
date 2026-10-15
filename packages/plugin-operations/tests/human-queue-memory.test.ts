import { InMemoryHumanQueueService } from '../src/human-queue/memory.ts';
import { describeHumanQueueService } from './human-queue/suite.ts';
import { T0 } from './human-queue/harness.ts';

describeHumanQueueService('human queues on the in-memory service', async () => {
  const service = new InMemoryHumanQueueService();
  service.clock.set(T0);
  return {
    org: 'org',
    service,
    clock: service.clock,
    bindPoint: async (pointId, queueIds) => service.bindPoint(pointId, queueIds),
    events: async (ticketId) => service.memory.eventsOf(ticketId),
    close: async () => undefined,
  };
});
