import type { HandoffPrepareFailure } from '@winsendotai/ovo-contracts';

/*
 * The human queue types the worker reads, from the contracts (human queue design 4). This module
 * only gathers them under one import for the human_* modules.
 */
export {
  HUMAN_METER_KEYS,
  TICKET_OUTCOMES,
  TICKET_RELEASE_CODES,
  type DeskCommand,
  type DestinationPolicy,
  type ExternalQueue,
  type HumanQueueDefinition,
  type ManagedQueue,
  type MediaRoomProvider,
  type QueueContextPolicy,
  type QueueSnapshot,
  type RoomSeat,
  type TicketContext,
  type TicketOutcome,
  type TicketReleaseCode,
  type WebhookDestination,
  type WebhookSpec,
} from '@winsendotai/ovo-contracts';
export type { HumanQueuePort, NewTicket, Ticket } from './human-store.ts';

/** The caller's identity in a room; an operator's is `op:<user id>` (design 11). */
export const CALLER_IDENTITY = 'caller';

/** Why a human handoff is refused at `begin`, before anything is announced (design 9.1). */
export type HumanRefusal = Extract<
  HandoffPrepareFailure,
  'queue_unknown' | 'queue_closed' | 'queue_unavailable' | 'queue_full' | 'no_operators'
>;
