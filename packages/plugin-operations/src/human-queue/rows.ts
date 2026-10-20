import { createHash } from 'node:crypto';
import {
  humanRoomName,
  type DeskCommand,
  type HumanQueueDefinition,
  type HumanTicketView,
  type OperatorProfile,
  type OperatorStatus,
  type TicketContext,
  type TicketOutcome,
  type TicketReleaseCode,
  type WebhookDestination,
  type WrapUp,
} from '@winsendotai/ovo-contracts';
import type { ManagedQueueRef, Ticket, TicketStatus } from './service.ts';

/** The stored shapes both stores speak; times are `Date`, absent values are `undefined`. */
export interface TicketRow {
  id: string;
  callId: string;
  sessionId?: string;
  idempotencyKey: string;
  routingReleaseId?: string;
  queueId: string;
  queueKey: string;
  queueName: string;
  kind: 'external' | 'managed';
  mode: 'AUTO_ASSIGN' | 'OPEN_PICKUP';
  /** From the pinned queue at create: who may take the ticket. */
  teamIds: string[];
  languageMode: ManagedQueueRef['language'];
  offerSeconds: number;
  status: TicketStatus;
  version: number;
  priority: number;
  language?: string;
  callerMasked?: string;
  assignedOperatorId?: string;
  declinedBy: string[];
  offerExpiresAt?: Date;
  expiresAt: Date;
  roomName?: string;
  acceptedAt?: Date;
  connectedAt?: Date;
  releasedAt?: Date;
  releaseCode?: TicketReleaseCode;
  outcome?: TicketOutcome;
  workerHeartbeatAt?: Date;
  command?: DeskCommand;
  commandSeq: number;
  commandAck: number;
  wrapUp?: WrapUp;
  routerAgentId?: string;
  credentialId?: string;
  callbackUntil?: Date;
  externalRef?: string;
  destination?: WebhookDestination;
  context?: TicketContext;
  contextRetentionHours: number;
  contextExpiresAt?: Date;
  contextTokenHash?: string;
  contextTokenExpiresAt?: Date;
  changeId: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperatorRecord extends OperatorProfile {
  status: OperatorStatus;
  statusAt: Date;
  lastSeenAt?: Date;
  lastAssignedAt?: Date;
}

export interface QueueRecord {
  id: string;
  name: string;
  kind: 'external' | 'managed';
  definition: HumanQueueDefinition;
  teamIds: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

export const ACTIVE: readonly TicketStatus[] = ['waiting', 'offered', 'accepted'];
export const isActive = (row: Pick<TicketRow, 'status'>) => ACTIVE.includes(row.status);
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const iso = (date: Date | undefined) => date?.toISOString();
const cut = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export function presentTicket(row: TicketRow, organizationId: string): Ticket {
  return cut({
    id: row.id,
    workspaceId: organizationId,
    sessionId: row.sessionId ?? row.callId,
    queueId: row.queueId,
    status: row.status,
    version: row.version,
    assignedOperatorId: row.assignedOperatorId,
    callId: row.callId,
    queueKey: row.queueKey,
    queueName: row.queueName,
    kind: row.kind,
    mode: row.mode,
    priority: row.priority,
    language: row.language,
    roomName: row.roomName,
    offerExpiresAt: iso(row.offerExpiresAt),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: iso(row.acceptedAt),
    connectedAt: iso(row.connectedAt),
    releasedAt: iso(row.releasedAt),
    releaseCode: row.releaseCode,
    outcome: row.outcome,
    command: row.command
      ? { seq: row.commandSeq, ack: row.commandAck, body: row.command }
      : undefined,
    destination: row.destination,
    externalRef: row.externalRef,
    routerAgentId: row.routerAgentId,
    credentialId: row.credentialId,
    callbackUntil: iso(row.callbackUntil),
    wrapUp: row.wrapUp,
    createdAt: row.createdAt.toISOString(),
  });
}

/** The operator-facing row. The full caller number never leaves `context`. */
export function presentView(row: TicketRow, userId: string, now: Date): HumanTicketView {
  return cut({
    id: row.id,
    queueId: row.queueId,
    queueKey: row.queueKey,
    queueName: row.queueName,
    kind: row.kind,
    mode: row.mode,
    status: row.status,
    version: row.version,
    priority: row.priority,
    language: row.language,
    callerMasked: row.callerMasked,
    createdAt: row.createdAt.toISOString(),
    waitMs: Math.max(0, (row.releasedAt ?? now).getTime() - row.createdAt.getTime()),
    offeredToMe: row.status === 'offered' && row.assignedOperatorId === userId,
    offerExpiresAt: iso(row.offerExpiresAt),
    assignedOperatorId: row.assignedOperatorId,
    connectedAt: iso(row.connectedAt),
    releasedAt: iso(row.releasedAt),
    releaseCode: row.releaseCode,
  });
}

/** The caller as a list shows it: the country prefix and last two digits. */
export function maskNumber(number: string | undefined): string | undefined {
  if (!number) return undefined;
  return number.length <= 6 ? '••••' : `${number.slice(0, 3)}••••${number.slice(-2)}`;
}

export const roomNameFor = humanRoomName;
