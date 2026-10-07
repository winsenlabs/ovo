import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkspaceCompliance } from '@winsendotai/ovo-contracts';
import { normalizePhoneNumber } from '../csv.ts';
import { transaction } from '../database.ts';
import type { DoNotCallService } from '../do-not-call.ts';

export type ComplaintKind = 'customer' | 'oap_notice' | 'ai_flag_notice' | 'appeal' | 'regulator';
export type ComplaintStatus = 'open' | 'acknowledged' | 'represented' | 'resolved' | 'closed';

export interface ComplaintInput {
  kind: ComplaintKind;
  phoneNumber?: string;
  cli?: string;
  callId?: string;
  receivedAt: Date;
  channel?: string;
  oapRef?: string;
  summary?: string;
  /** Stop calling the complainant while the complaint is open (default on for customers). */
  suppress?: boolean;
}

export interface ComplaintRecord extends Omit<ComplaintInput, 'suppress'> {
  id: string;
  status: ComplaintStatus;
  ackDueAt?: Date;
  resolveDueAt: Date;
  acknowledgedAt?: Date;
  resolution?: string;
  resolvedAt?: Date;
  /** The SLA deadline this complaint has missed, if any. */
  overdue?: 'ack' | 'resolve';
  actions: Array<{ at: string; action: string; note?: string }>;
}

const HOUR = 3_600_000;
const IST = 330 * 60_000;

/** `days` business days (Monday to Friday, IST) after `from`: an OAP notice's reply window (R21). */
export function addBusinessDays(from: Date, days: number): Date {
  let at = from.getTime();
  let left = days;
  while (left > 0) {
    at += 24 * HOUR;
    const weekday = new Date(at + IST).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return new Date(at);
}

/**
 * SLA deadlines: a telco or regulator notice must be answered within the representation window
 * (5 business days, TCCCPR Reg 25); a customer complaint is acknowledged in 24 hours and resolved
 * in 7 days, the CCPA draft's grievance timelines adopted as a conservative default (Q12).
 */
export function complaintDeadlines(
  kind: ComplaintKind,
  receivedAt: Date,
  sla: WorkspaceCompliance['complaintSla'],
): { ackDueAt?: Date; resolveDueAt: Date } {
  if (kind === 'customer' || kind === 'appeal')
    return {
      ackDueAt: new Date(receivedAt.getTime() + sla.ackHours * HOUR),
      resolveDueAt: new Date(receivedAt.getTime() + sla.resolveDays * 24 * HOUR),
    };
  return { resolveDueAt: addBusinessDays(receivedAt, sla.representBusinessDays) };
}

const NEXT: Record<string, ComplaintStatus[]> = {
  open: ['acknowledged', 'represented', 'resolved', 'closed'],
  acknowledged: ['represented', 'resolved', 'closed'],
  represented: ['resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

/** Complaints, telco notices and appeals (G14), with SLA timers and an action trail. */
export class ComplaintService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly doNotCall: DoNotCallService,
  ) {}

  async open(
    input: ComplaintInput,
    sla: WorkspaceCompliance['complaintSla'],
    db?: PoolClient,
  ): Promise<ComplaintRecord> {
    const phoneNumber = input.phoneNumber ? normalizePhoneNumber(input.phoneNumber) : undefined;
    const deadlines = complaintDeadlines(input.kind, input.receivedAt, sla);
    const work = async (client: PoolClient) => {
      const result = await client.query(
        `INSERT INTO ovo_ops_complaints (id, organization_id, kind, phone_number, cli, call_id,
           received_at, channel, oap_ref, summary, ack_due_at, resolve_due_at, actions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,
        [
          randomUUID(),
          this.organizationId,
          input.kind,
          phoneNumber ?? null,
          input.cli ?? null,
          input.callId ?? null,
          input.receivedAt,
          input.channel ?? null,
          input.oapRef ?? null,
          input.summary ?? null,
          deadlines.ackDueAt ?? null,
          deadlines.resolveDueAt,
          JSON.stringify([{ at: new Date().toISOString(), action: 'opened' }]),
        ],
      );
      if (phoneNumber && (input.suppress ?? input.kind === 'customer'))
        await this.doNotCall.upsert(client, phoneNumber, 'Complaint received', 'complaint', {});
      return fromRow(result.rows[0]);
    };
    return db ? work(db) : transaction(this.pool, work);
  }

  async transition(
    id: string,
    status: ComplaintStatus,
    note?: string,
  ): Promise<ComplaintRecord | 'invalid_transition'> {
    return transaction(this.pool, async (client) => {
      const current = await client.query(
        'SELECT * FROM ovo_ops_complaints WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [id, this.organizationId],
      );
      const row = current.rows[0];
      if (!row) throw new Error('Complaint not found');
      if (!NEXT[row.status]!.includes(status)) return 'invalid_transition';
      const action = { at: new Date().toISOString(), action: status, ...(note ? { note } : {}) };
      const result = await client.query(
        `UPDATE ovo_ops_complaints SET status = $3,
           acknowledged_at = COALESCE(acknowledged_at, now()),
           resolved_at = CASE WHEN $3 IN ('resolved','closed') THEN COALESCE(resolved_at, now()) END,
           resolution = CASE WHEN $3 IN ('resolved','closed') THEN COALESCE($4, resolution)
             ELSE resolution END,
           actions = actions || $5::jsonb, updated_at = now()
         WHERE id = $1 AND organization_id = $2 RETURNING *`,
        [id, this.organizationId, status, note ?? null, JSON.stringify([action])],
      );
      return fromRow(result.rows[0]);
    });
  }

  async list(
    options: { status?: 'active' | 'all'; limit?: number } = {},
  ): Promise<ComplaintRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ovo_ops_complaints WHERE organization_id = $1
         AND ($2 = 'all' OR status IN ('open','acknowledged','represented'))
       ORDER BY resolve_due_at, id LIMIT $3`,
      [this.organizationId, options.status ?? 'active', Math.min(options.limit ?? 100, 500)],
    );
    return result.rows.map((row) => fromRow(row));
  }
}

function fromRow(row: Record<string, unknown>, now = Date.now()): ComplaintRecord {
  const date = (key: string) => (row[key] ? (row[key] as Date) : undefined);
  const active = ['open', 'acknowledged', 'represented'].includes(row.status as string);
  const ackDueAt = date('ack_due_at');
  const resolveDueAt = row.resolve_due_at as Date;
  const overdue =
    active && ackDueAt && !row.acknowledged_at && ackDueAt.getTime() < now
      ? 'ack'
      : active && resolveDueAt.getTime() < now
        ? 'resolve'
        : undefined;
  const optional = Object.entries({
    phoneNumber: row.phone_number,
    cli: row.cli,
    callId: row.call_id,
    channel: row.channel,
    oapRef: row.oap_ref,
    summary: row.summary,
    ackDueAt,
    acknowledgedAt: date('acknowledged_at'),
    resolution: row.resolution,
    resolvedAt: date('resolved_at'),
    overdue,
  }).filter(([, value]) => value !== null && value !== undefined);
  return {
    id: row.id as string,
    kind: row.kind as ComplaintKind,
    receivedAt: row.received_at as Date,
    status: row.status as ComplaintStatus,
    resolveDueAt,
    actions: row.actions as ComplaintRecord['actions'],
    ...Object.fromEntries(optional),
  } as ComplaintRecord;
}
