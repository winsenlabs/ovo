import type { RoomGrant } from '@winsendotai/ovo-ui/room';

/**
 * The operator desk's wire shapes (Wave 17 design 4.3 and 6.2): what `/v1/desk/*` returns. Kept
 * as plain interfaces because the console reads JSON and renders it as text; the API validates.
 */
export const TICKET_STATUSES = ['waiting', 'offered', 'accepted', 'released', 'expired'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const OPERATOR_STATUSES = ['AVAILABLE', 'AWAY', 'OFFLINE'] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];

/** A row of the queue. The caller number is masked until accept. */
export interface HumanTicketView {
  id: string;
  queueId: string;
  queueKey: string;
  queueName: string;
  kind: 'external' | 'managed';
  mode: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
  status: TicketStatus;
  version: number;
  priority: number;
  language?: string;
  callerMasked?: string;
  createdAt: string;
  waitMs: number;
  offeredToMe: boolean;
  offerExpiresAt?: string;
  assignedOperatorId?: string;
  connectedAt?: string;
  releasedAt?: string;
  releaseCode?: string;
}

/** Sensitive; returned only to the assigned operator. Everything in it is text to display. */
export interface TicketContext {
  callId: string;
  brief: string;
  summary?: string;
  reason?: string;
  language?: string;
  intent?: string;
  routePath: string[];
  caller: { number?: string; calledNumber?: string };
  transcript: { role: 'caller' | 'agent'; text: string }[];
  variables: Record<string, string | number | boolean>;
  fromAgent?: { agentId: string; releaseId: string };
  returnTargets: { key: string; label: string }[];
}

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

export interface DeskAcceptResult {
  ticket: HumanTicketView;
  room: RoomGrant;
  context: TicketContext;
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
