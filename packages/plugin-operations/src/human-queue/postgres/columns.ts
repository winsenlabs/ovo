import type { OperatorRecord, QueueRecord, TicketRow } from '../rows.ts';

type Kind = 'text' | 'int' | 'ts' | 'json' | 'texts';

/** Ticket fields and the column each one lives in, with the cast the driver needs. */
const TICKET: { [K in keyof TicketRow]-?: [column: string, kind: Kind] } = {
  id: ['id', 'text'],
  callId: ['call_id', 'text'],
  sessionId: ['session_id', 'text'],
  idempotencyKey: ['idempotency_key', 'text'],
  routingReleaseId: ['routing_release_id', 'text'],
  queueId: ['queue_id', 'text'],
  queueKey: ['queue_key', 'text'],
  queueName: ['queue_name', 'text'],
  kind: ['kind', 'text'],
  mode: ['mode', 'text'],
  teamIds: ['team_ids', 'texts'],
  languageMode: ['language_mode', 'text'],
  offerSeconds: ['offer_seconds', 'int'],
  status: ['status', 'text'],
  version: ['version', 'int'],
  priority: ['priority', 'int'],
  language: ['language', 'text'],
  callerMasked: ['caller_masked', 'text'],
  assignedOperatorId: ['assigned_operator_id', 'text'],
  declinedBy: ['declined_by', 'texts'],
  offerExpiresAt: ['offer_expires_at', 'ts'],
  expiresAt: ['expires_at', 'ts'],
  roomName: ['room_name', 'text'],
  acceptedAt: ['accepted_at', 'ts'],
  connectedAt: ['connected_at', 'ts'],
  releasedAt: ['released_at', 'ts'],
  releaseCode: ['release_code', 'text'],
  outcome: ['outcome', 'text'],
  workerHeartbeatAt: ['worker_heartbeat_at', 'ts'],
  command: ['command', 'json'],
  commandSeq: ['command_seq', 'int'],
  commandAck: ['command_ack', 'int'],
  wrapUp: ['wrap_up', 'json'],
  routerAgentId: ['router_agent_id', 'text'],
  credentialId: ['credential_id', 'text'],
  callbackUntil: ['callback_until', 'ts'],
  externalRef: ['external_ref', 'text'],
  destination: ['destination', 'json'],
  context: ['context', 'json'],
  contextRetentionHours: ['context_retention_hours', 'int'],
  contextExpiresAt: ['context_expires_at', 'ts'],
  contextTokenHash: ['context_token_hash', 'text'],
  contextTokenExpiresAt: ['context_token_expires_at', 'ts'],
  changeId: ['change_id', 'int'],
  createdAt: ['created_at', 'ts'],
  updatedAt: ['updated_at', 'ts'],
};

const CAST: Record<Kind, string> = {
  text: '',
  int: '',
  ts: '::timestamptz',
  json: '::jsonb',
  texts: '::text[]',
};
// `uuid` columns accept text parameters; the id-like text columns need no cast.
const UUIDS = new Set(['id', 'routing_release_id', 'queue_id']);

const encode = (kind: Kind, value: unknown) => (kind === 'json' ? JSON.stringify(value) : value);

export type TicketKey = keyof typeof TICKET;
export const TICKET_FIELDS = Object.keys(TICKET) as TicketKey[];

/** Columns, typed placeholders and values for the fields present in `patch`; `null` clears. */
export function bind(
  patch: Record<string, unknown>,
  firstParam: number,
): { columns: string[]; params: string[]; values: unknown[] } {
  const columns: string[] = [];
  const params: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const spec = TICKET[key as TicketKey];
    if (!spec) throw new Error(`Unknown ticket field ${key}`);
    const [column, kind] = spec;
    values.push(value === null ? null : encode(kind, value));
    columns.push(column);
    params.push(`$${firstParam + values.length - 1}${UUIDS.has(column) ? '::uuid' : CAST[kind]}`);
  }
  return { columns, params, values };
}

type Row = Record<string, unknown>;

/** A ticket as the database returns it. */
export function ticketFromRow(row: Row): TicketRow {
  const out: Record<string, unknown> = {};
  for (const key of TICKET_FIELDS) {
    const [column, kind] = TICKET[key];
    const value = row[column];
    if (value === null || value === undefined) {
      if (kind === 'texts') out[key] = [];
      continue;
    }
    out[key] = kind === 'int' ? Number(value) : value;
  }
  return out as unknown as TicketRow;
}

export function operatorFromRow(row: Row): OperatorRecord {
  const optional = <T>(value: T | null | undefined) => (value === null ? undefined : value);
  return {
    userId: String(row.user_id),
    displayName: String(row.display_name),
    enabled: row.enabled === true,
    teamIds: row.team_ids as string[],
    languages: row.languages as string[],
    capacity: Number(row.capacity),
    status: row.status as OperatorRecord['status'],
    statusAt: row.status_at as Date,
    ...(optional(row.last_seen_at) ? { lastSeenAt: row.last_seen_at as Date } : {}),
    ...(optional(row.last_assigned_at) ? { lastAssignedAt: row.last_assigned_at as Date } : {}),
  };
}

export function queueFromRow(row: Row): QueueRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as QueueRecord['kind'],
    definition: row.definition as QueueRecord['definition'],
    teamIds: row.team_ids as string[],
    version: Number(row.version),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    ...(row.deleted_at ? { deletedAt: row.deleted_at as Date } : {}),
  };
}
