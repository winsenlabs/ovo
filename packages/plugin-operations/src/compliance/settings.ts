import { WorkspaceCompliance } from '@winsendotai/ovo-contracts';
import type { Pool } from 'pg';
import type { Database } from '../types.ts';
import { policyProblems, type PolicyProblem } from './policy.ts';
import { IN_TCCCPR_2026_10 } from './rule-packs.ts';

export interface ComplianceSettingsRecord {
  settings: WorkspaceCompliance;
  version: number;
  updatedAt: Date | null;
}

export class ComplianceSettingsConflict extends Error {
  constructor(readonly current: ComplianceSettingsRecord) {
    super('Compliance settings changed');
  }
}

export class ComplianceSettingsInvalid extends Error {
  constructor(readonly problems: PolicyProblem[]) {
    super(problems.map((problem) => problem.message).join('; '));
  }
}

/**
 * Write-time checks on the workspace settings: the A2P date may only move earlier than the rule
 * pack's, and every default window must stay inside the floor of its category and purpose.
 */
export function settingsProblems(settings: WorkspaceCompliance): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  const pack = IN_TCCCPR_2026_10;
  if (settings.enforcement.a2pDeclarationRequiredFrom > pack.a2pDeclarationRequiredFrom!)
    problems.push({
      code: 'policy_widens_floor',
      message: `A2P declarations are required from ${pack.a2pDeclarationRequiredFrom} at the latest`,
      source: 'enforcement',
    });
  for (const key of ['promotional', 'service', 'transactional', 'rbi_recovery'] as const) {
    if (!settings.windows[key]) continue;
    const policy =
      key === 'rbi_recovery'
        ? ({ version: 1, category: 'service', purpose: 'rbi_recovery' } as const)
        : ({ version: 1, category: key } as const);
    // The workspace layer is checked as if it were the agent's own window.
    const asAgent = {
      ...policy,
      agentWindow: { rules: settings.windows[key]!.rules, timezone: 'UTC' },
    };
    for (const problem of policyProblems(pack, settings, asAgent, { requireCategory: false }))
      problems.push({ ...problem, message: `${key} window: ${problem.message}`, source: key });
  }
  return problems;
}

/** The workspace's compliance settings row; absent means every default. */
export class ComplianceSettingsStore {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {}

  async get(db: Database = this.pool): Promise<ComplianceSettingsRecord> {
    const result = await db.query<{ settings: unknown; version: number; updated_at: Date }>(
      'SELECT settings, version, updated_at FROM ovo_ops_compliance_settings WHERE organization_id = $1',
      [this.organizationId],
    );
    const row = result.rows[0];
    if (!row) return { settings: WorkspaceCompliance.parse({}), version: 0, updatedAt: null };
    return {
      settings: WorkspaceCompliance.parse(row.settings),
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  /** Replaces the settings when `expectedVersion` matches (0 for a workspace that has none). */
  async put(input: unknown, expectedVersion: number): Promise<ComplianceSettingsRecord> {
    const settings = WorkspaceCompliance.parse(input);
    const problems = settingsProblems(settings);
    if (problems.length) throw new ComplianceSettingsInvalid(problems);
    const json = JSON.stringify(settings);
    const result = await this.pool.query<{ version: number; updated_at: Date }>(
      expectedVersion === 0
        ? `INSERT INTO ovo_ops_compliance_settings (organization_id, settings) VALUES ($1, $2::jsonb)
           ON CONFLICT (organization_id) DO NOTHING RETURNING version, updated_at`
        : `UPDATE ovo_ops_compliance_settings SET settings = $2::jsonb, version = version + 1,
             updated_at = now() WHERE organization_id = $1 AND version = $3
           RETURNING version, updated_at`,
      expectedVersion === 0
        ? [this.organizationId, json]
        : [this.organizationId, json, expectedVersion],
    );
    const row = result.rows[0];
    if (!row) throw new ComplianceSettingsConflict(await this.get());
    return { settings, version: row.version, updatedAt: row.updated_at };
  }
}
