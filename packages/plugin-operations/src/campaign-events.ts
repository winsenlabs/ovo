import type { Pool } from 'pg';
import { transaction } from './database.ts';
import type { AttemptTerminalStatus, CampaignCounters, ContactState } from './types.ts';

export class CampaignEventService {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async recordAttempt(
    attemptId: string,
    eventId: string,
    status: 'dialing' | 'connected' | AttemptTerminalStatus,
    occurredAt: Date,
    reason?: string,
  ): Promise<'applied' | 'duplicate' | 'ignored_terminal' | 'ignored_out_of_order'> {
    return transaction(this.pool, async (client) => {
      const event = await client.query(
        `INSERT INTO ovo_ops_attempt_events (event_id, attempt_id, status, payload, occurred_at)
         VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (event_id) DO NOTHING`,
        [eventId, attemptId, status, JSON.stringify(reason ? { reason } : {}), occurredAt],
      );
      if (!event.rowCount) return 'duplicate';
      const attempt = await client.query<{ status: string; contact_id: string }>(
        `SELECT a.status, a.contact_id FROM ovo_ops_attempts a JOIN ovo_ops_campaigns c ON c.id = a.campaign_id
         WHERE a.id = $1 AND c.organization_id = $2 FOR UPDATE OF a`,
        [attemptId, this.organizationId],
      );
      const row = attempt.rows[0];
      if (!row) throw new Error('Attempt not found');
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(row.status))
        return 'ignored_terminal';
      const progressRank = { authorized: 0, dialing: 1, connected: 2 } as const;
      if (
        status in progressRank &&
        progressRank[status as keyof typeof progressRank] <=
          progressRank[row.status as keyof typeof progressRank]
      )
        return 'ignored_out_of_order';
      await client.query(
        `UPDATE ovo_ops_attempts SET status = $2, terminal_reason = $3, updated_at = now() WHERE id = $1`,
        [attemptId, status, reason ?? null],
      );
      const contactState: ContactState =
        status === 'connected' ? 'active' : status === 'dialing' ? 'dialing' : status;
      await client.query(
        'UPDATE ovo_ops_campaign_contacts SET state = $2, updated_at = now() WHERE id = $1',
        [row.contact_id, contactState],
      );
      return 'applied';
    });
  }

  async counters(campaignId: string): Promise<CampaignCounters> {
    const campaign = await this.pool.query(
      'SELECT 1 FROM ovo_ops_campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, this.organizationId],
    );
    if (!campaign.rowCount) throw new Error('Campaign not found');
    const [contacts, attempts] = await Promise.all([
      this.pool.query<{ state: ContactState; count: string }>(
        `SELECT CASE
           WHEN k.status = 'cancelled' AND c.state IN ('queued', 'admitted') THEN 'cancelled'
           WHEN c.state = 'admitted' AND c.admission_campaign_version <> k.version THEN 'queued'
           ELSE c.state END AS state, count(*)::text AS count
         FROM ovo_ops_campaign_contacts c JOIN ovo_ops_campaigns k ON k.id = c.campaign_id
         WHERE c.campaign_id = $1
         GROUP BY CASE
           WHEN k.status = 'cancelled' AND c.state IN ('queued', 'admitted') THEN 'cancelled'
           WHEN c.state = 'admitted' AND c.admission_campaign_version <> k.version THEN 'queued'
           ELSE c.state END`,
        [campaignId],
      ),
      this.pool.query<{ status: keyof CampaignCounters['attempts']; count: string }>(
        'SELECT status, count(*)::text AS count FROM ovo_ops_attempts WHERE campaign_id = $1 GROUP BY status',
        [campaignId],
      ),
    ]);
    const contactCounts = Object.fromEntries(
      [
        'queued',
        'admitted',
        'dialing',
        'active',
        'succeeded',
        'failed',
        'cancelled',
        'unknown',
        'suppressed',
        'exhausted',
      ].map((state) => [state, 0]),
    ) as CampaignCounters['contacts'];
    const attemptCounts = Object.fromEntries(
      ['authorized', 'dialing', 'connected', 'succeeded', 'failed', 'cancelled', 'unknown'].map(
        (state) => [state, 0],
      ),
    ) as CampaignCounters['attempts'];
    for (const row of contacts.rows) contactCounts[row.state] = Number(row.count);
    for (const row of attempts.rows) attemptCounts[row.status] = Number(row.count);
    return { contacts: contactCounts, attempts: attemptCounts };
  }
}
