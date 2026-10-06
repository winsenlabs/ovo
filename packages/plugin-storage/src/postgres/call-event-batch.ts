import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { StoredCallEvent } from '../models.ts';
import { now, transaction } from './shared.ts';

export type CallEventDraft = { type: string; payload: Record<string, unknown>; epoch?: number };

/**
 * OBS-10: several events of one call in one transaction. The call row lock serialises writers of
 * the call, exactly as appendCallEvent does, so sequences stay consecutive and gap-free.
 */
export async function appendCallEventBatch(
  pool: Pool,
  workspaceId: string,
  callId: string,
  events: readonly CallEventDraft[],
): Promise<StoredCallEvent[]> {
  if (!events.length) return [];
  return transaction(pool, async (client) => {
    const call = await client.query(
      'SELECT 1 FROM ovo_ctl_calls WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [workspaceId, callId],
    );
    if (!call.rowCount) throw new Error('Call not found');
    const next = await client.query<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM ovo_ctl_call_events
       WHERE workspace_id=$1 AND call_id=$2`,
      [workspaceId, callId],
    );
    const first = Number(next.rows[0]!.sequence);
    const at = now();
    const stored = events.map<StoredCallEvent>((event, index) => ({
      id: randomUUID(),
      callId,
      sequence: first + index,
      at,
      type: event.type,
      epoch: event.epoch ?? 0,
      payload: event.payload,
    }));
    // One multi-row INSERT: one round trip for the whole batch.
    await client.query(
      `INSERT INTO ovo_ctl_call_events (workspace_id,call_id,id,sequence,at,type,epoch,payload)
       SELECT $1, $2, * FROM unnest($3::text[], $4::int[], $5::timestamptz[], $6::text[],
         $7::int[], $8::jsonb[])`,
      [
        workspaceId,
        callId,
        stored.map((event) => event.id),
        stored.map((event) => event.sequence),
        stored.map((event) => event.at),
        stored.map((event) => event.type),
        stored.map((event) => event.epoch),
        stored.map((event) => JSON.stringify(event.payload)),
      ],
    );
    return stored;
  });
}
