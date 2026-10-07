/**
 * What the regulator export and the evidence packet read: one query per CSV file, bound by name
 * (`:org`, `:from`, `:to`, `:phone`, `:campaign`) so each query binds only the parameters it uses.
 */
export type Named = Record<'org' | 'from' | 'to' | 'phone' | 'campaign', unknown>;

/** Numbers the `:name` placeholders a query uses, so each query binds only its own parameters. */
export function bind(sql: string, named: Named): [string, unknown[]] {
  const order: string[] = [];
  const text = sql.replace(/:(org|from|to|phone|campaign)\b/g, (_match, name: string) => {
    if (!order.includes(name)) order.push(name);
    return `$${order.indexOf(name) + 1}`;
  });
  return [text, order.map((name) => named[name as keyof Named])];
}

export const QUERIES: ReadonlyArray<{ name: string; columns: string[]; sql: string }> = [
  {
    name: 'decisions.csv',
    columns: [
      'id',
      'decided_at',
      'stage',
      'campaign_id',
      'contact_id',
      'attempt_id',
      'phone_number',
      'from_number',
      'category',
      'rule_pack',
      'policy_hash',
      'verdict',
      'reason',
      'warnings',
      'bypass',
      'consent_id',
      'preference_check_ref',
      'next_eligible_at',
    ],
    sql: `SELECT * FROM ovo_ops_compliance_decisions WHERE organization_id = :org
      AND decided_at >= :from AND decided_at < :to AND (:phone::text IS NULL OR phone_number = :phone)
      AND (:campaign::uuid IS NULL OR campaign_id = :campaign) ORDER BY decided_at, id`,
  },
  {
    name: 'attempts.csv',
    columns: [
      'attempt_id',
      'phone_number',
      'from_number',
      'series',
      'category',
      'purpose',
      'campaign_id',
      'contact_id',
      'call_id',
      'authorized_at',
      'connected_at',
      'ended_at',
      'terminal_status',
      'outcome',
      'disposition',
    ],
    sql: `SELECT * FROM ovo_ops_recipient_attempts WHERE organization_id = :org
      AND authorized_at >= :from AND authorized_at < :to
      AND (:phone::text IS NULL OR phone_number = :phone)
      AND (:campaign::uuid IS NULL OR campaign_id = :campaign) ORDER BY authorized_at, attempt_id`,
  },
  {
    name: 'consents.csv',
    columns: [
      'id',
      'phone_number',
      'principal_entity',
      'purpose',
      'category',
      'basis',
      'evidence_ref',
      'customer_initiated',
      'obtained_at',
      'expires_at',
      'revoked_at',
      'revocation_source',
      'revocation_ref',
      'created_at',
    ],
    sql: `SELECT * FROM ovo_ops_consents WHERE organization_id = :org
      AND (:phone::text IS NULL OR phone_number = :phone)
      AND obtained_at < :to AND (revoked_at IS NULL OR revoked_at >= :from) ORDER BY obtained_at, id`,
  },
  {
    name: 'suppressions.csv',
    columns: [
      'phone_number',
      'source',
      'scope',
      'purpose',
      'lock_until',
      'reason',
      'call_id',
      'created_at',
      'updated_at',
    ],
    sql: `SELECT * FROM ovo_ops_suppressions WHERE organization_id = :org AND created_at < :to
      AND (:phone::text IS NULL OR phone_number = :phone) ORDER BY phone_number`,
  },
  {
    name: 'preference_checks.csv',
    columns: [
      'phone_number',
      'provider',
      'result',
      'blocked_categories',
      'blocked_time_bands',
      'blocked_day_types',
      'checked_at',
      'provider_ref',
    ],
    sql: `SELECT * FROM ovo_ops_preference_checks WHERE organization_id = :org AND checked_at < :to
      AND (:phone::text IS NULL OR phone_number = :phone) ORDER BY phone_number, provider`,
  },
  {
    name: 'complaints.csv',
    columns: [
      'id',
      'kind',
      'phone_number',
      'cli',
      'call_id',
      'received_at',
      'channel',
      'oap_ref',
      'summary',
      'ack_due_at',
      'resolve_due_at',
      'status',
      'acknowledged_at',
      'resolution',
      'resolved_at',
    ],
    sql: `SELECT * FROM ovo_ops_complaints WHERE organization_id = :org
      AND received_at >= :from AND received_at < :to
      AND (:phone::text IS NULL OR phone_number = :phone) ORDER BY received_at, id`,
  },
  {
    name: 'cli_numbers.csv',
    columns: [
      'phone_number',
      'series',
      'categories',
      'dlt_entity_id',
      'oap',
      'status',
      'flagged_at',
      'flag_note',
      'updated_at',
    ],
    sql: `SELECT * FROM ovo_ops_cli_numbers WHERE organization_id = :org ORDER BY phone_number`,
  },
  {
    name: 'a2p_declarations.csv',
    columns: [
      'id',
      'range_start',
      'range_end',
      'oap',
      'reference',
      'declared_at',
      'effective_from',
      'withdrawn_at',
    ],
    sql: `SELECT id, range_start, range_end, oap, reference, declared_at::text AS declared_at,
      effective_from::text AS effective_from, withdrawn_at FROM ovo_ops_a2p_declarations
      WHERE organization_id = :org ORDER BY created_at`,
  },
];
