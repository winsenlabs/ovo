import type { HumanQueueService, NewTicket, Ticket } from '@winsendotai/ovo-plugin-operations';

export type { NewTicket, Ticket };

/**
 * What the worker uses of `HumanQueueService` (human queue design 4.5): the shared ticket store.
 * The worker (which holds the call), the API (which serves operators) and the sweeper meet in
 * the ticket row; a narrower type keeps the worker from reaching for what is not its to use.
 */
export interface HumanQueuePort {
  readonly enabled: boolean;
  queues: Pick<HumanQueueService['queues'], 'stats'>;
  operators: Pick<HumanQueueService['operators'], 'availability'>;
  tickets: Pick<
    HumanQueueService['tickets'],
    | 'create'
    | 'get'
    | 'release'
    | 'reoffer'
    | 'workerBeat'
    | 'markConnected'
    | 'ackCommand'
    | 'markHandedOff'
    | 'appendEvent'
    | 'issueContextToken'
  >;
}
