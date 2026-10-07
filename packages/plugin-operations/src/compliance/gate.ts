import { randomUUID } from 'node:crypto';
import type { Database } from '../types.ts';
import { evaluateDial, type Verdict } from './evaluate.ts';
import { loadRecipientFacts } from './facts.ts';
import {
  policyHash,
  resolveCaps,
  windowLayers,
  type CompliancePolicy,
  type ResolvedCaps,
} from './policy.ts';
import type { PreferenceService } from './preferences.ts';
import { packFor } from './rule-packs.ts';
import type { ComplianceSettingsStore } from './settings.ts';
import { describeLayers } from './windows.ts';

export type ComplianceStage = 'create' | 'admit' | 'authorize' | 'manual' | 'redrive' | 'post_call';

export interface GateInput {
  stage: ComplianceStage;
  phoneNumber: string;
  fromNumber: string;
  policy: CompliancePolicy;
  campaignId?: string;
  contactId?: string;
  attemptId?: string;
  skipWindow?: boolean;
  now?: Date;
}

export interface GateResult extends Verdict {
  decisionId: string;
  rulePack: string;
  policyHash: string;
}

export interface Evaluated {
  result: GateResult;
  now: Date;
  window: ReturnType<typeof describeLayers>;
  caps: ResolvedCaps;
}

/**
 * Runs the evaluator for one dial and writes its decision row on the same connection, so a
 * decision commits or rolls back with whatever it allowed (spec 3.5, G15).
 */
export class ComplianceGate {
  constructor(
    private readonly organizationId: string,
    private readonly settings: ComplianceSettingsStore,
    private readonly preferences?: Pick<PreferenceService, 'refresh'>,
  ) {}

  /** Evaluates and records the decision. */
  async check(db: Database, input: GateInput): Promise<GateResult> {
    const evaluated = await this.evaluate(db, input);
    await this.record(db, input, evaluated);
    return evaluated.result;
  }

  /** Evaluates without recording: the console's preview of a contact list. */
  async evaluate(db: Database, input: GateInput): Promise<Evaluated> {
    const now = input.now ?? new Date();
    const { settings, version } = await this.settings.get(db);
    if (this.preferences && input.policy.category === 'promotional')
      await this.preferences.refresh(
        db,
        settings.scrub.provider,
        [input.phoneNumber],
        'promotional',
        now,
      );
    const pack = packFor(input.phoneNumber);
    const facts = await loadRecipientFacts(db, this.organizationId, {
      phoneNumber: input.phoneNumber,
      fromNumber: input.fromNumber,
      settings,
      provider: settings.scrub.provider,
      now,
    });
    const verdict = evaluateDial({
      pack,
      settings,
      policy: input.policy,
      recipient: input.phoneNumber,
      facts,
      now,
      skipWindow: input.skipWindow,
    });
    const result: GateResult = {
      ...verdict,
      decisionId: randomUUID(),
      rulePack: `${pack.id}@${pack.version}`,
      policyHash: policyHash(pack, version, input.policy),
    };
    return {
      result,
      now,
      window: describeLayers(windowLayers(pack, settings, input.policy)),
      caps: resolveCaps(pack, settings, input.policy),
    };
  }

  /** Writes a decision row on `db`, in whatever transaction it belongs to. */
  async record(db: Database, input: GateInput, evaluated: Evaluated): Promise<void> {
    const { result, now } = evaluated;
    await db.query(
      `INSERT INTO ovo_ops_compliance_decisions (id, organization_id, decided_at, stage, campaign_id,
         contact_id, attempt_id, phone_number, from_number, category, rule_pack, policy_hash, verdict,
         reason, warnings, bypass, consent_id, preference_check_ref, window_effective, caps_snapshot,
         details, next_eligible_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,
         $21::jsonb,$22)`,
      [
        result.decisionId,
        this.organizationId,
        now,
        input.stage,
        input.campaignId ?? null,
        input.contactId ?? null,
        input.attemptId ?? null,
        input.phoneNumber,
        input.fromNumber,
        input.policy.category ?? null,
        result.rulePack,
        result.policyHash,
        result.verdict,
        result.reason ?? null,
        result.warnings,
        result.bypass ?? null,
        result.consentId ?? null,
        result.preferenceRef ?? null,
        JSON.stringify(evaluated.window),
        JSON.stringify(evaluated.caps),
        result.details ? JSON.stringify(result.details) : null,
        result.nextEligibleAt ?? null,
      ],
    );
  }
}
