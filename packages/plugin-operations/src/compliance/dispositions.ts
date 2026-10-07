import type { Pool } from 'pg';
import { transaction } from '../database.ts';
import type { DoNotCallService } from '../do-not-call.ts';
import type { ComplaintService } from './complaints.ts';
import { dispositionOutcome } from './retry-policy.ts';
import type { ComplianceSettingsStore } from './settings.ts';

/** Reads each call's final disposition from the call outcome store, by call id. */
export type DispositionLookup = (callIds: readonly string[]) => Promise<Map<string, string>>;

/** How long after the attempt ends the worker has to write the call's disposition. */
const SETTLE_MS = 10 * 60_000;
const BATCH = 100;

interface PendingRow {
  attempt_id: string;
  call_id: string;
  phone_number: string;
  purpose: string | null;
  ended_at: Date;
}

/**
 * Stage E7 after the call: folds each ended attempt's flow disposition into the ledger and acts on
 * it. A do-not-call disposition lists the number as an opt-out (90-day lock), a wrong number
 * suppresses it for that purpose, a dispute opens a complaint, a refusal starts a cool-off.
 */
export class DispositionSweep {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly settings: ComplianceSettingsStore,
    private readonly doNotCall: DoNotCallService,
    private readonly complaints: ComplaintService,
  ) {}

  async run(lookup: DispositionLookup, now = new Date()): Promise<number> {
    const pending = await this.pool.query<PendingRow>(
      `SELECT attempt_id, call_id, phone_number, purpose, ended_at FROM ovo_ops_recipient_attempts
       WHERE organization_id = $1 AND ended_at IS NOT NULL AND disposition_checked_at IS NULL
       ORDER BY ended_at LIMIT ${BATCH}`,
      [this.organizationId],
    );
    if (!pending.rowCount) return 0;
    const withCall = pending.rows.filter((row) => row.call_id);
    const dispositions = withCall.length
      ? await lookup(withCall.map((row) => row.call_id))
      : new Map<string, string>();
    const { settings } = await this.settings.get();
    let applied = 0;
    for (const row of pending.rows) {
      const disposition = row.call_id ? dispositions.get(row.call_id) : undefined;
      if (!disposition && now.getTime() - row.ended_at.getTime() < SETTLE_MS && row.call_id)
        continue;
      const outcome = disposition ? dispositionOutcome(disposition, settings) : undefined;
      await transaction(this.pool, async (client) => {
        const marked = await client.query(
          `UPDATE ovo_ops_recipient_attempts SET disposition = $3, disposition_checked_at = now(),
             outcome = COALESCE($4, outcome)
           WHERE organization_id = $1 AND attempt_id = $2 AND disposition_checked_at IS NULL`,
          [this.organizationId, row.attempt_id, disposition ?? null, outcome ?? null],
        );
        if (!marked.rowCount || !outcome) return;
        if (outcome === 'opted_out')
          await this.doNotCall.upsert(
            client,
            row.phone_number,
            'Caller asked not to be called',
            'opt_out',
            {
              callId: row.call_id,
            },
          );
        else if (outcome === 'wrong_number')
          await this.doNotCall.upsert(client, row.phone_number, 'Wrong number', 'wrong_number', {
            scope: 'purpose',
            purpose: row.purpose ?? 'other',
            callId: row.call_id,
          });
        else if (outcome === 'dispute')
          await this.complaints.open(
            {
              kind: 'customer',
              phoneNumber: row.phone_number,
              callId: row.call_id,
              receivedAt: now,
              channel: 'in_call',
              summary: `Disposition ${disposition}`,
              suppress: false,
            },
            settings.complaintSla,
            client,
          );
      });
      applied += 1;
    }
    return applied;
  }
}
