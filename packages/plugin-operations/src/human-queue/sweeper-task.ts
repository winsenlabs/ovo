import type { HumanQueueService } from './service.ts';

/**
 * The dispatcher's human-queue pass: assigns AUTO_ASSIGN offers, expires deadlines and lapsed
 * offers, releases tickets whose worker stopped, scrubs old contexts. Any number of dispatchers
 * may run it: the store's single-flight lock lets one sweep at a time.
 */
export class HumanQueueSweeperTask {
  readonly id = 'human-queue-sweeper';
  readonly intervalMs = 1_000;

  constructor(
    private readonly queues: Pick<HumanQueueService, 'enabled' | 'sweep'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A no-op while OVO_HUMAN_QUEUE_ENABLED is off. */
  async tick(): Promise<void> {
    if (this.queues.enabled) await this.queues.sweep(this.now());
  }
}
