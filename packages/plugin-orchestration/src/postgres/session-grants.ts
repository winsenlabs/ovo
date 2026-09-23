import type { Pool, PoolClient } from 'pg';
import type {
  AdmissionSnapshot,
  BindCarrierCallInput,
  BindCarrierCallResult,
  IssueStreamGrantInput,
  ReissueStreamInput,
  SessionRoute,
} from '../types.ts';
import { transaction } from './database.ts';
import { callIdAvailable, lockCarrierCallId } from './call-identity.ts';
import { fromSessionRouteRow, sessionRouteColumns, type SessionRouteRow } from './session-model.ts';

const grantable =
  "status IN ('dialing', 'accepted') AND terminal_at IS NULL AND terminal_reason IS NULL AND handshake_claimed_at IS NULL";

function checkToken(tokenHash: string, expiresAt: Date): void {
  if (!/^[a-f0-9]{64}$/i.test(tokenHash) || expiresAt.getTime() <= Date.now())
    throw new Error('Stream grant requires a valid future token hash');
}

async function lockRoute(
  client: PoolClient,
  predicate: string,
  values: unknown[],
  carrierCallId?: string,
): Promise<SessionRouteRow | undefined> {
  const sql = `SELECT ${sessionRouteColumns} FROM ovo_session_routes WHERE ${predicate}`;
  const preview = await client.query<SessionRouteRow>(`${sql} LIMIT 2`, values);
  if (preview.rows.length !== 1) return undefined;
  // All writers that touch both rows acquire the job lock before the route lock.
  await client.query('SELECT id FROM ovo_jobs WHERE id = $1 FOR UPDATE', [preview.rows[0]!.job_id]);
  if (carrierCallId) await lockCarrierCallId(client, carrierCallId);
  const locked = await client.query<SessionRouteRow>(`${sql} FOR UPDATE`, values);
  return locked.rows.length === 1 && locked.rows[0]!.session_id === preview.rows[0]!.session_id
    ? locked.rows[0]
    : undefined;
}

export class SessionGrantRepository {
  constructor(private readonly pool: Pool) {}

  async bindCarrierCallId(input: BindCarrierCallInput): Promise<BindCarrierCallResult> {
    if ((!input.sessionId && !input.dialRequestId) || !input.carrierCallId)
      throw new Error('Call id binding requires a route and carrier call id');
    return transaction(this.pool, async (client) => {
      const row = await lockRoute(
        client,
        '($1::uuid IS NULL OR session_id = $1) AND ($2::text IS NULL OR dial_request_id = $2)',
        [input.sessionId ?? null, input.dialRequestId ?? null],
        input.carrierCallId,
      );
      if (!row) return { kind: 'unmatched' };
      if (row.terminal_at || row.terminal_reason || row.status === 'terminating')
        return { kind: 'conflict' };
      if (!(await callIdAvailable(client, row.job_id, input.carrierCallId)))
        return { kind: 'conflict' };
      const column = !row.carrier_call_id
        ? 'carrier_call_id'
        : row.carrier_call_id === input.carrierCallId
          ? undefined
          : !row.carrier_stream_call_id
            ? 'carrier_stream_call_id'
            : row.carrier_stream_call_id === input.carrierCallId
              ? undefined
              : null;
      if (column === null) return { kind: 'conflict' };
      if (!column)
        return {
          kind: row.carrier_call_id === input.carrierCallId ? 'bound' : 'alias',
          route: fromSessionRouteRow(row),
        };
      const updated = await client.query<SessionRouteRow>(
        `UPDATE ovo_session_routes SET ${column} = $2, updated_at = now()
         WHERE session_id = $1 RETURNING ${sessionRouteColumns}`,
        [row.session_id, input.carrierCallId],
      );
      if (column === 'carrier_call_id')
        await client.query(
          'UPDATE ovo_jobs SET carrier_call_id = $2 WHERE id = $1 AND carrier_call_id IS NULL',
          [row.job_id, input.carrierCallId],
        );
      return {
        kind: column === 'carrier_call_id' ? 'bound' : 'alias',
        route: fromSessionRouteRow(updated.rows[0]!),
      };
    });
  }

  async issueStreamGrant(input: IssueStreamGrantInput): Promise<SessionRoute | undefined> {
    if (!input.dialRequestId && !input.carrierRequestId && !input.carrierCallId)
      throw new Error('Stream grant requires correlation');
    checkToken(input.tokenHash, input.expiresAt);
    return transaction(this.pool, async (client) => {
      // A request id is authoritative when the stream's call id differs from the dial id.
      const row = await lockRoute(
        client,
        `($1::text IS NULL OR dial_request_id = $1)
           AND ($2::text IS NULL OR carrier_request_id = $2)
           AND ($1::text IS NOT NULL OR $2::text IS NOT NULL OR
                carrier_call_id = $3 OR carrier_stream_call_id = $3)`,
        [input.dialRequestId ?? null, input.carrierRequestId ?? null, input.carrierCallId ?? null],
        input.carrierCallId,
      );
      if (
        !row ||
        !['dialing', 'accepted'].includes(row.status) ||
        row.terminal_at ||
        row.terminal_reason ||
        row.handshake_claimed_at
      )
        return undefined;
      let primary = row.carrier_call_id;
      let alias = row.carrier_stream_call_id;
      if (input.carrierCallId && input.carrierCallId !== primary && input.carrierCallId !== alias) {
        if (!(await callIdAvailable(client, row.job_id, input.carrierCallId))) return undefined;
        if (!primary) primary = input.carrierCallId;
        else if (!alias) alias = input.carrierCallId;
        else return undefined;
      }
      const updated = await client.query<SessionRouteRow>(
        `UPDATE ovo_session_routes SET carrier_call_id = $2, carrier_stream_call_id = $3,
           handshake_token_hash = $4, handshake_expires_at = $5, updated_at = now()
         WHERE session_id = $1 AND ${grantable}
         RETURNING ${sessionRouteColumns}`,
        [row.session_id, primary, alias, input.tokenHash, input.expiresAt],
      );
      if (!updated.rows[0]) return undefined;
      if (primary && !row.carrier_call_id)
        await client.query(
          'UPDATE ovo_jobs SET carrier_call_id = $2 WHERE id = $1 AND carrier_call_id IS NULL',
          [row.job_id, primary],
        );
      return fromSessionRouteRow(updated.rows[0]);
    });
  }

  async reissueStream(input: ReissueStreamInput): Promise<SessionRoute | undefined> {
    checkToken(input.tokenHash, input.expiresAt);
    if (
      !input.carrierCallId ||
      !Number.isFinite(input.workerFreshSeconds) ||
      input.workerFreshSeconds <= 0
    )
      throw new Error('Invalid stream resume request');
    const updated = await this.pool.query<SessionRouteRow>(
      `UPDATE ovo_session_routes r SET generation = generation + 1,
         handshake_token_hash = $2, handshake_expires_at = $3,
         handshake_claimed_at = NULL, updated_at = now()
       FROM ovo_worker_slots s, ovo_jobs j
       WHERE (r.carrier_call_id = $1 OR r.carrier_stream_call_id = $1)
         AND r.status = 'connected' AND r.terminal_at IS NULL AND r.terminal_reason IS NULL
         AND s.worker_id = r.worker_id AND s.state IN ('reserved', 'active')
         AND s.observed_at >= now() - ($4 * interval '1 second')
         AND s.lease_expires_at > now()
         AND r.worker_slot_epoch IS NOT NULL AND s.ownership_epoch = r.worker_slot_epoch
         AND j.id = r.job_id AND j.owner_id = r.worker_id AND j.owner_epoch = r.owner_epoch
         AND j.status = 'connected' AND j.lease_expires_at > now()
         AND NOT EXISTS (SELECT 1 FROM ovo_session_routes x WHERE x.session_id <> r.session_id
           AND (x.carrier_call_id = $1 OR x.carrier_stream_call_id = $1))
       RETURNING ${sessionRouteColumns
         .split(/,\s*/)
         .map((column) => `r.${column}`)
         .join(', ')}`,
      [input.carrierCallId, input.tokenHash, input.expiresAt, input.workerFreshSeconds],
    );
    return updated.rows[0] ? fromSessionRouteRow(updated.rows[0]) : undefined;
  }

  async admissionSnapshot(): Promise<AdmissionSnapshot> {
    const result = await this.pool.query<{
      ready_idle_slots: string;
      eligible_queued_jobs: string;
      busy_slots: string;
    }>(`SELECT
      (SELECT count(*) FROM ovo_worker_slots WHERE state = 'ready_idle' AND lease_expires_at > now())::text AS ready_idle_slots,
      (SELECT count(*) FROM ovo_jobs WHERE status = 'queued' AND not_before <= now())::text AS eligible_queued_jobs,
      (SELECT count(*) FROM ovo_worker_slots WHERE state IN ('reserved', 'active') AND lease_expires_at > now())::text AS busy_slots`);
    const row = result.rows[0]!;
    return {
      readyIdleSlots: Number(row.ready_idle_slots),
      eligibleQueuedJobs: Number(row.eligible_queued_jobs),
      busySlots: Number(row.busy_slots),
    };
  }
}
