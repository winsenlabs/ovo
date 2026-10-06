import type { PoolClient } from 'pg';
import { callingWindowState } from './calling-window.ts';
import type { CampaignRow, ContactRow } from './campaign-model.ts';
import { validateReleaseVariables } from './release-variables.ts';

/** Invalid contacts one admission marks before it gives up until the next tick. */
const MAX_INVALID_SKIPS = 100;

/**
 * The next dialable contact. One whose variables fail the release schema snapshotted at create is
 * marked `invalid` and skipped: it could only reach the agent with fields its lines cannot fill.
 */
export async function nextValidContact(
  client: PoolClient,
  campaign: CampaignRow,
  organizationId: string,
): Promise<ContactRow | undefined> {
  for (let skipped = 0; skipped <= MAX_INVALID_SKIPS; skipped += 1) {
    const selected = await client.query<ContactRow>(
      `SELECT c.* FROM ovo_ops_campaign_contacts c
         WHERE c.campaign_id = $1 AND c.state = 'queued' AND c.not_before <= now()
           AND NOT EXISTS (SELECT 1 FROM ovo_ops_suppressions s
             WHERE s.organization_id = $2 AND s.phone_number = c.phone_number)
           AND (SELECT count(*) FROM ovo_ops_attempts a WHERE a.contact_id = c.id) < $3
         ORDER BY c.source_row, c.id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [campaign.id, organizationId, campaign.per_number_attempt_limit],
    );
    const contact = selected.rows[0];
    if (!contact || !campaign.variables_schema) return contact;
    if (validateReleaseVariables(campaign.variables_schema, contact.variables).valid)
      return contact;
    await client.query(
      `UPDATE ovo_ops_campaign_contacts SET state = 'invalid', updated_at = now() WHERE id = $1`,
      [contact.id],
    );
  }
  return undefined;
}

/**
 * A contact admitted inside the calling window but authorized after it closed goes back in the
 * queue until the window opens, instead of being dialed. True when it was requeued.
 */
export async function requeueOutsideWindow(
  client: PoolClient,
  campaign: CampaignRow,
  contactId: string,
): Promise<boolean> {
  const window = campaign.calling_window ? callingWindowState(campaign.calling_window) : undefined;
  if (!window || window.open) return false;
  await client.query(
    `UPDATE ovo_ops_campaign_contacts SET state = 'queued', owner_id = NULL,
     admission_campaign_version = NULL, lease_expires_at = NULL, not_before = $2,
     updated_at = now() WHERE id = $1`,
    [contactId, window.nextOpenAt],
  );
  return true;
}
