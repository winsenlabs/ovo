import type { Pool, QueryResultRow } from 'pg';
import { transaction } from './database.ts';

interface RetryContactRow extends QueryResultRow {
  id: string;
  campaign_id: string;
  phone_number: string;
  state: string;
  per_number_attempt_limit: number;
  campaign_status: string;
}

export type RedriveResult =
  | { kind: 'queued' }
  | {
      kind: 'blocked';
      reason:
        | 'campaign_cancelled'
        | 'not_failed'
        | 'unknown_outcome'
        | 'connected_attempt'
        | 'suppressed'
        | 'attempt_limit';
    };

export class CampaignRetryService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async redrive(contactId: string, notBefore: Date): Promise<RedriveResult> {
    if (!Number.isFinite(notBefore.getTime())) throw new Error('notBefore is invalid');
    return transaction(this.pool, async (client) => {
      const identity = await client.query<{ campaign_id: string }>(
        `SELECT c.campaign_id FROM ovo_ops_campaign_contacts c JOIN ovo_ops_campaigns k ON k.id = c.campaign_id
         WHERE c.id = $1 AND k.organization_id = $2`,
        [contactId, this.organizationId],
      );
      if (!identity.rows[0]) throw new Error('Campaign contact not found');
      await client.query('SELECT id FROM ovo_ops_campaigns WHERE id = $1 FOR UPDATE', [
        identity.rows[0].campaign_id,
      ]);
      const contact = await client.query<RetryContactRow>(
        `SELECT c.id, c.campaign_id, c.phone_number, c.state,
           k.per_number_attempt_limit, k.status AS campaign_status
         FROM ovo_ops_campaign_contacts c JOIN ovo_ops_campaigns k ON k.id = c.campaign_id
         WHERE c.id = $1 FOR UPDATE OF c`,
        [contactId],
      );
      const current = contact.rows[0]!;
      if (current.campaign_status === 'cancelled' || current.campaign_status === 'completed')
        return { kind: 'blocked', reason: 'campaign_cancelled' };
      if (current.state !== 'failed') return { kind: 'blocked', reason: 'not_failed' };
      const history = await client.query<{
        attempts: string;
        unknown: boolean;
        connected: boolean;
      }>(
        `SELECT count(*)::text AS attempts,
          bool_or(a.status = 'unknown') AS unknown,
          EXISTS (SELECT 1 FROM ovo_ops_attempt_events e
            JOIN ovo_ops_attempts x ON x.id = e.attempt_id
            WHERE x.contact_id = $1 AND e.status = 'connected') AS connected
         FROM ovo_ops_attempts a WHERE a.contact_id = $1`,
        [contactId],
      );
      if (history.rows[0]!.unknown) return { kind: 'blocked', reason: 'unknown_outcome' };
      if (history.rows[0]!.connected) return { kind: 'blocked', reason: 'connected_attempt' };
      if (Number(history.rows[0]!.attempts) >= current.per_number_attempt_limit)
        return { kind: 'blocked', reason: 'attempt_limit' };
      const suppression = await client.query(
        'SELECT 1 FROM ovo_ops_suppressions WHERE organization_id = $1 AND phone_number = $2',
        [this.organizationId, current.phone_number],
      );
      if (suppression.rowCount) {
        await client.query(
          `UPDATE ovo_ops_campaign_contacts SET state = 'suppressed', updated_at = now() WHERE id = $1`,
          [contactId],
        );
        return { kind: 'blocked', reason: 'suppressed' };
      }
      await client.query(
        `UPDATE ovo_ops_campaign_contacts SET state = 'queued', not_before = $2,
         owner_id = NULL, admission_campaign_version = NULL,
         lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
        [contactId, notBefore],
      );
      return { kind: 'queued' };
    });
  }
}
