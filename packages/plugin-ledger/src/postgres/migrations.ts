import type { Pool } from 'pg';
import migration001 from '../../migrations/001_cost_ledger.sql?raw';
import migration002 from '../../migrations/002_reservation_expiry.sql?raw';
import migration003 from '../../migrations/003_price_card_model.sql?raw';
import migration004 from '../../migrations/004_exact_charge_amount.sql?raw';
import { transaction } from './database.ts';

export async function runCostMigrations(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-cost-ledger-migrations-v1'))");
    const catalog = await client.query<{ name: string | null }>(
      "SELECT to_regclass('ovo_cost_schema_migrations')::text AS name",
    );
    const firstApplied = catalog.rows[0]?.name
      ? await client.query('SELECT 1 FROM ovo_cost_schema_migrations WHERE version = 1')
      : undefined;
    if (!firstApplied?.rowCount) await client.query(migration001);
    await validateLegacySchema(client);
    const secondApplied = await client.query(
      'SELECT 1 FROM ovo_cost_schema_migrations WHERE version = 2',
    );
    if (!secondApplied.rowCount) {
      await client.query(migration002);
      await client.query('INSERT INTO ovo_cost_schema_migrations(version) VALUES (2)');
    }
    const thirdApplied = await client.query(
      'SELECT 1 FROM ovo_cost_schema_migrations WHERE version = 3',
    );
    if (!thirdApplied.rowCount) {
      await client.query(migration003);
      await client.query('INSERT INTO ovo_cost_schema_migrations(version) VALUES (3)');
    }
    const fourthApplied = await client.query(
      'SELECT 1 FROM ovo_cost_schema_migrations WHERE version = 4',
    );
    if (!fourthApplied.rowCount) {
      await client.query(migration004);
      await client.query('INSERT INTO ovo_cost_schema_migrations(version) VALUES (4)');
    }
  });
}

async function validateLegacySchema(client: import('pg').PoolClient): Promise<void> {
  const required: Record<string, readonly string[]> = {
    ovo_cost_price_cards: [
      'id',
      'version',
      'provider',
      'unit',
      'currency',
      'minor_units_per_block',
      'block_quantity',
    ],
    ovo_cost_fx_versions: [
      'id',
      'version',
      'base_currency',
      'quote_currency',
      'rate_numerator',
      'rate_denominator',
    ],
    ovo_cost_native_usage: [
      'id',
      'workspace_id',
      'session_id',
      'source_kind',
      'source_event_type',
      'source_event_id',
      'quantity',
      'unit',
      'state',
    ],
    ovo_cost_charges: ['id', 'usage_id', 'amount_paise', 'price_card_id', 'price_card_version'],
    ovo_cost_corrections: ['id', 'usage_id', 'delta_paise'],
    ovo_cost_allocation_batches: ['id', 'charge_id', 'amount_paise'],
    ovo_cost_allocations: ['batch_id', 'target_id', 'amount_paise'],
    ovo_cost_budgets: ['id', 'workspace_id', 'limit_paise', 'spent_paise', 'reserved_paise'],
    ovo_cost_reservations: ['id', 'budget_id', 'amount_paise', 'source_ref', 'state'],
    ovo_cost_budget_adjustments: ['id', 'budget_id', 'delta_paise'],
  };
  const columns = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name,column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [Object.keys(required)],
  );
  const available = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
  for (const [table, names] of Object.entries(required))
    for (const name of names)
      if (!available.has(`${table}.${name}`))
        throw new Error(`Cost ledger legacy schema is incomplete: ${table}.${name}`);

  const primaryKeys: Record<string, readonly string[]> = {
    ovo_cost_schema_migrations: ['version'],
    ovo_cost_price_cards: ['id', 'version'],
    ovo_cost_fx_versions: ['id', 'version'],
    ovo_cost_native_usage: ['id'],
    ovo_cost_charges: ['id'],
    ovo_cost_corrections: ['id'],
    ovo_cost_allocation_batches: ['id'],
    ovo_cost_allocations: ['batch_id', 'target_id'],
    ovo_cost_budgets: ['id'],
    ovo_cost_reservations: ['id'],
    ovo_cost_budget_adjustments: ['id'],
  };
  const keys = await client.query<{ table_name: string; columns: string[] }>(
    `SELECT rel.relname AS table_name, array_agg(att.attname::text ORDER BY key.ordinality) AS columns
     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     JOIN LATERAL unnest(con.conkey) WITH ORDINALITY key(attnum, ordinality) ON true
     JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = key.attnum
     WHERE ns.nspname = current_schema() AND con.contype = 'p'
       AND rel.relname = ANY($1::text[])
     GROUP BY rel.relname`,
    [Object.keys(primaryKeys)],
  );
  const actual = new Map(keys.rows.map((row) => [row.table_name, row.columns]));
  for (const [table, expected] of Object.entries(primaryKeys))
    if (actual.get(table)?.join(',') !== expected.join(','))
      throw new Error(`Cost ledger legacy schema is incomplete: ${table}.primary_key`);
}
