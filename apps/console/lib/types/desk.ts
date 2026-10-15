import type {
  DeskAcceptResult,
  HumanTicketView,
  OperatorStatus,
  TicketContext,
} from '@winsendotai/ovo-contracts';

/**
 * The operator desk's wire shapes (Wave 17 design 4.3 and 6.2): what `/v1/desk/*` returns. The
 * ticket, its context and the accept result are the contract's own types (type-only imports, so
 * nothing of the contracts package reaches the browser); the rest is the console's reading of
 * `/v1/desk/me`, where the API validates and this only renders.
 */
export type { DeskAcceptResult, HumanTicketView, OperatorStatus, TicketContext };
export type TicketStatus = HumanTicketView['status'];
export const TICKET_STATUSES = [
  'waiting',
  'offered',
  'accepted',
  'released',
  'expired',
] as const satisfies readonly TicketStatus[];
export const OPERATOR_STATUSES = [
  'AVAILABLE',
  'AWAY',
  'OFFLINE',
] as const satisfies readonly OperatorStatus[];

export interface DeskQueueInfo {
  id: string;
  name: string;
  assignment: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
  returnTargets: { key: string; label: string }[];
  wrapUp: { required: boolean; dispositions: string[] };
}

export interface DeskStats {
  handledToday: number;
  activeNow: number;
  onlineOperators: number;
}

export interface DeskMe {
  profile: {
    userId: string;
    displayName: string;
    enabled: boolean;
    teamIds: string[];
    languages: string[];
    capacity: number;
  };
  status: OperatorStatus;
  queues: DeskQueueInfo[];
  roomProvider: { provider: string; serverUrl: string };
  presenceTtlSeconds: number;
  stats: DeskStats;
}

/** `GET /v1/human-queues/status`: whether the desk can take calls here, and why not. */
export interface HumanQueueStatus {
  enabled: boolean;
  webhookEnabled: boolean;
  managedAvailable: boolean;
  room: { configured: boolean; provider?: string; reachable?: boolean; publicUrl?: string };
  sweeper?: { lastRunAt?: string };
}

/** What the SSE stream carries, by event name. */
export type DeskStreamEvent =
  | { type: 'ticket'; ticket: HumanTicketView }
  | { type: 'removed'; id: string }
  | { type: 'me'; me: Partial<Pick<DeskMe, 'status' | 'stats'>> }
  | { type: 'gap' }
  | { type: 'heartbeat' };
