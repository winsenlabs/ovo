import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OperatorRecord, QueueRecord, TicketRow } from '../rows.ts';
import type { TicketEventInput } from '../service.ts';
import { HqConflictError, type HqTx, type TicketFilter, type TicketPatch } from '../store.ts';
import { bind, operatorFromRow, queueFromRow, ticketFromRow } from './columns.ts';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** One transaction of the human-queue tables for one organization. */
export class PgTx implements HqTx {
  constructor(
    private readonly client: PoolClient,
    private readonly org: string,
    private readonly now: () => Date,
  ) {}

  async lockOperator(userId: string): Promise<void> {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      `ovo-hq-operator:${this.org}`,
      userId,
    ]);
  }

  async lockCall(callId: string): Promise<void> {
    await this.client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      `ovo-hq-call:${this.org}`,
      callId,
    ]);
  }

  async operator(userId: string): Promise<OperatorRecord | undefined> {
    const result = await this.client.query(
      'SELECT * FROM ovo_hq_operators WHERE organization_id = $1 AND user_id = $2',
      [this.org, userId],
    );
    return result.rows[0] ? operatorFromRow(result.rows[0]) : undefined;
  }

  async operators(): Promise<OperatorRecord[]> {
    const result = await this.client.query(
      'SELECT * FROM ovo_hq_operators WHERE organization_id = $1 ORDER BY user_id',
      [this.org],
    );
    return result.rows.map(operatorFromRow);
  }

  async putOperator(record: OperatorRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO ovo_hq_operators (organization_id, user_id, display_name, enabled, team_ids,
         languages, capacity, status, status_at, last_seen_at, last_assigned_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8, $9, $10, $11)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name,
         enabled = EXCLUDED.enabled, team_ids = EXCLUDED.team_ids, languages = EXCLUDED.languages,
         capacity = EXCLUDED.capacity, status = EXCLUDED.status, status_at = EXCLUDED.status_at,
         last_seen_at = EXCLUDED.last_seen_at, last_assigned_at = EXCLUDED.last_assigned_at`,
      [
        this.org,
        record.userId,
        record.displayName,
        record.enabled,
        record.teamIds,
        record.languages,
        record.capacity,
        record.status,
        record.statusAt,
        record.lastSeenAt ?? null,
        record.lastAssignedAt ?? null,
      ],
    );
  }

  async ticket(id: string, lock = false): Promise<TicketRow | undefined> {
    if (!UUID.test(id)) return undefined;
    const result = await this.client.query(
      `SELECT * FROM ovo_hq_tickets WHERE organization_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
      [this.org, id],
    );
    return result.rows[0] ? ticketFromRow(result.rows[0]) : undefined;
  }

  async scan(filter: TicketFilter): Promise<TicketRow[]> {
    const where = ['organization_id = $1'];
    const values: unknown[] = [this.org];
    const add = (sql: string, value: unknown, cast = '') => {
      values.push(value);
      where.push(sql.replace('?', `$${values.length}${cast}`));
    };
    if (filter.queueId !== undefined) {
      if (!UUID.test(filter.queueId)) return [];
      add('queue_id = ?', filter.queueId, '::uuid');
    }
    if (filter.statuses) add('status = ANY(?)', [...filter.statuses], '::text[]');
    if (filter.kind) add('kind = ?', filter.kind);
    if (filter.assignedTo !== undefined) add('assigned_operator_id = ?', filter.assignedTo);
    if (filter.callId !== undefined) add('call_id = ?', filter.callId);
    if (filter.idempotencyKey !== undefined) add('idempotency_key = ?', filter.idempotencyKey);
    if (filter.sinceChangeId !== undefined) add('change_id > ?', filter.sinceChangeId);
    if (filter.releasedSince) add('released_at >= ?', filter.releasedSince, '::timestamptz');
    if (filter.scrubDue)
      add('context IS NOT NULL AND context_expires_at <= ?', filter.scrubDue, '::timestamptz');
    const order =
      filter.sinceChangeId === undefined ? 'priority DESC, created_at, id' : 'change_id, id';
    const limit =
      filter.limit === undefined ? '' : ` LIMIT ${Math.max(1, Math.trunc(filter.limit))}`;
    const lock = filter.lock ? ' FOR UPDATE SKIP LOCKED' : '';
    const result = await this.client.query(
      `SELECT * FROM ovo_hq_tickets WHERE ${where.join(' AND ')} ORDER BY ${order}${limit}${lock}`,
      values,
    );
    return result.rows.map(ticketFromRow);
  }

  async insertTicket(row: Omit<TicketRow, 'changeId'>): Promise<TicketRow> {
    const { columns, params, values } = bind(row as Record<string, unknown>, 2);
    try {
      const result = await this.client.query(
        `INSERT INTO ovo_hq_tickets (organization_id, ${columns.join(', ')})
         VALUES ($1, ${params.join(', ')}) RETURNING *`,
        [this.org, ...values],
      );
      return ticketFromRow(result.rows[0]);
    } catch (error) {
      // Our own statement failed, so the transaction is dead: the engine retries it whole.
      if ((error as { code?: string }).code === '23505') throw new HqConflictError();
      throw error;
    }
  }

  async updateTicket(id: string, patch: TicketPatch): Promise<TicketRow> {
    const { columns, params, values } = bind(patch as Record<string, unknown>, 4);
    const sets = columns.map((column, i) => `${column} = ${params[i]}`);
    const result = await this.client.query(
      `UPDATE ovo_hq_tickets SET ${sets.length ? `${sets.join(', ')}, ` : ''}
         updated_at = $3::timestamptz, change_id = nextval('ovo_hq_change_seq')
       WHERE organization_id = $1 AND id = $2 RETURNING *`,
      [this.org, id, this.now(), ...values],
    );
    if (!result.rows[0]) throw new Error('Unknown human queue ticket');
    return ticketFromRow(result.rows[0]);
  }

  async touchTicket(
    id: string,
    patch: { workerHeartbeatAt?: Date; commandAck?: number },
  ): Promise<void> {
    const { columns, params, values } = bind(patch, 3);
    if (!columns.length) return;
    await this.client.query(
      `UPDATE ovo_hq_tickets SET ${columns.map((c, i) => `${c} = ${params[i]}`).join(', ')}
       WHERE organization_id = $1 AND id = $2`,
      [this.org, id, ...values],
    );
  }

  async addEvent(ticketId: string, event: TicketEventInput, at: Date) {
    const result = await this.client.query(
      `INSERT INTO ovo_hq_ticket_events
         (organization_id, ticket_id, id, kind, source_event_id, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (organization_id, ticket_id, source_event_id) WHERE source_event_id IS NOT NULL
       DO NOTHING`,
      [
        this.org,
        ticketId,
        randomUUID(),
        event.kind,
        event.sourceEventId ?? null,
        JSON.stringify(event.payload),
        at,
      ],
    );
    return result.rowCount ? ('recorded' as const) : ('duplicate' as const);
  }

  async hasEvent(ticketId: string, sourceEventId: string): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1 FROM ovo_hq_ticket_events
       WHERE organization_id = $1 AND ticket_id = $2 AND source_event_id = $3`,
      [this.org, ticketId, sourceEventId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async queue(id: string): Promise<QueueRecord | undefined> {
    if (!UUID.test(id)) return undefined;
    const result = await this.client.query(
      'SELECT * FROM ovo_hq_queues WHERE organization_id = $1 AND id = $2',
      [this.org, id],
    );
    return result.rows[0] ? queueFromRow(result.rows[0]) : undefined;
  }
}
