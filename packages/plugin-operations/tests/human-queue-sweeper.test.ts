import { describe, expect, it, vi } from 'vitest';
import { InMemoryHumanQueueService } from '../src/human-queue/memory.ts';
import { HumanQueueSweeperTask } from '../src/human-queue/sweeper-task.ts';
import { managedDefinition, profile, ticketFor } from './human-queue/harness.ts';

describe('the human queue sweeper task', () => {
  it('does nothing while the human queue flag is off', async () => {
    const sweep = vi.fn();
    await new HumanQueueSweeperTask({ enabled: false, sweep }).tick();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('sweeps once a second with the current time when on', async () => {
    const sweep = vi.fn(async () => ({
      assigned: 0,
      expired: 0,
      reoffered: 0,
      scrubbed: 0,
      stale: 0,
    }));
    const now = new Date('2026-10-15T09:00:00.000Z');
    const task = new HumanQueueSweeperTask({ enabled: true, sweep }, () => now);
    await task.tick();
    expect(sweep).toHaveBeenCalledExactlyOnceWith(now);
    expect([task.id, task.intervalMs]).toEqual(['human-queue-sweeper', 1_000]);
  });

  it('offers a waiting AUTO_ASSIGN ticket when an operator comes online', async () => {
    const service = new InMemoryHumanQueueService();
    const queue = await service.queues.create(managedDefinition({ assignment: 'AUTO_ASSIGN' }));
    const ticket = await service.tickets.create(ticketFor(queue));
    if (ticket === 'queue_full') throw new Error('unexpected');
    await service.operators.upsert(profile('asha'));
    await service.operators.heartbeat('asha', 'AVAILABLE');
    await new HumanQueueSweeperTask(service, service.clock.now).tick();
    expect(await service.tickets.get(ticket.id)).toMatchObject({
      status: 'offered',
      assignedOperatorId: 'asha',
    });
  });
});
