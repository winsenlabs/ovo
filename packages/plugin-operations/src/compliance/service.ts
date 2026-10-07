import type { Pool } from 'pg';
import type { ComplianceRefusalCode, PreferenceProvider } from '@winsendotai/ovo-contracts';
import { boundedLimit } from '../database.ts';
import type { DoNotCallService } from '../do-not-call.ts';
import { ComplaintService, type ComplaintInput } from './complaints.ts';
import { ConsentService } from './consents.ts';
import { DispositionSweep, type DispositionLookup } from './dispositions.ts';
import { complianceExport, evidencePacket, type ExportFilter } from './export.ts';
import { ComplianceGate, type GateInput, type GateResult } from './gate.ts';
import {
  policyProblems,
  resolveCaps,
  windowLayers,
  type CompliancePolicy,
  type PolicyProblem,
} from './policy.ts';
import { PreferenceService } from './preferences.ts';
import { allCliRatios } from './ratios.ts';
import { CliRegistryService } from './registry.ts';
import { packFor } from './rule-packs.ts';
import { ComplianceSettingsStore } from './settings.ts';
import { refusalEffect } from './suppression-sql.ts';
import { describeLayers } from './windows.ts';

export interface ComplianceDecisionRecord {
  id: string;
  decidedAt: Date;
  stage: string;
  campaignId: string | null;
  contactId: string | null;
  attemptId: string | null;
  phoneNumber: string;
  fromNumber: string | null;
  verdict: string;
  reason: string | null;
  warnings: string[];
  bypass: string | null;
  nextEligibleAt: Date | null;
}

/** Everything compliance by configuration offers the API, the console and the dispatcher. */
export class ComplianceService {
  readonly settings: ComplianceSettingsStore;
  readonly gate: ComplianceGate;
  readonly cli: CliRegistryService;
  readonly consents: ConsentService;
  readonly preferences: PreferenceService;
  readonly complaints: ComplaintService;
  private readonly dispositions: DispositionSweep;

  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    doNotCall: DoNotCallService,
    settings: ComplianceSettingsStore,
    providers: readonly PreferenceProvider[] = [],
  ) {
    this.settings = settings;
    this.preferences = new PreferenceService(
      pool,
      organizationId,
      new Map(providers.map((provider) => [provider.id, provider])),
      doNotCall,
    );
    this.gate = new ComplianceGate(organizationId, settings, this.preferences);
    this.cli = new CliRegistryService(pool, organizationId);
    this.consents = new ConsentService(pool, organizationId);
    this.complaints = new ComplaintService(pool, organizationId, doNotCall);
    this.dispositions = new DispositionSweep(
      pool,
      organizationId,
      settings,
      doNotCall,
      this.complaints,
    );
  }

  /** Stage E1: what is wrong with a campaign's policy before any row is written. */
  async problems(
    policy: CompliancePolicy,
    recipients: readonly string[],
  ): Promise<PolicyProblem[]> {
    const { settings } = await this.settings.get();
    const indian = recipients.filter((recipient) => recipient.startsWith('+91'));
    const problems: PolicyProblem[] = [];
    if (indian.length)
      // Test numbers skip the registration checks, so a campaign of them needs no category.
      problems.push(
        ...policyProblems(packFor('+91'), settings, policy, {
          requireCategory: indian.some((recipient) => !settings.testNumbers.includes(recipient)),
        }),
      );
    if (indian.length < recipients.length)
      for (const problem of policyProblems(packFor(''), settings, policy, {
        requireCategory: false,
      }))
        if (!problems.some((known) => known.code === problem.code)) problems.push(problem);
    return problems;
  }

  /** The windows and caps a recipient would be judged against, as the console explains them. */
  async effective(policy: CompliancePolicy, recipient: string) {
    const { settings } = await this.settings.get();
    const pack = packFor(recipient);
    return {
      rulePack: `${pack.id}@${pack.version}`,
      layers: describeLayers(windowLayers(pack, settings, policy)),
      caps: resolveCaps(pack, settings, policy),
    };
  }

  /** Stage E2: how each number of an import would fare now, without recording decisions. */
  async preview(policy: CompliancePolicy, fromNumber: string, recipients: readonly string[]) {
    const verdicts: Array<{
      phoneNumber: string;
      verdict: string;
      reason?: ComplianceRefusalCode;
    }> = [];
    for (const phoneNumber of recipients.slice(0, 500)) {
      const { result } = await this.gate.evaluate(this.pool, {
        stage: 'create',
        phoneNumber,
        fromNumber,
        policy,
      });
      verdicts.push({
        phoneNumber,
        verdict: result.verdict,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
    return verdicts;
  }

  /** Stage E5: a manual or test call, judged and recorded when it is requested. */
  checkManual(input: Omit<GateInput, 'stage'>): Promise<GateResult> {
    return this.gate.check(this.pool, { ...input, stage: 'manual' });
  }

  /** Whether a refusal is about the sender (CLI, A2P, category) rather than one recipient. */
  pausesCampaign(reason: string): boolean {
    return refusalEffect(reason) === 'pause';
  }

  async openComplaint(input: ComplaintInput) {
    const { settings } = await this.settings.get();
    return this.complaints.open(input, settings.complaintSla);
  }

  async decisions(
    filter: { phoneNumber?: string; campaignId?: string; limit?: number } = {},
  ): Promise<ComplianceDecisionRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ovo_ops_compliance_decisions WHERE organization_id = $1
         AND ($2::text IS NULL OR phone_number = $2) AND ($3::uuid IS NULL OR campaign_id = $3)
       ORDER BY decided_at DESC, id LIMIT $4`,
      [
        this.organizationId,
        filter.phoneNumber ?? null,
        filter.campaignId ?? null,
        boundedLimit(filter.limit ?? 50),
      ],
    );
    return result.rows.map((row) => ({
      id: row.id,
      decidedAt: row.decided_at,
      stage: row.stage,
      campaignId: row.campaign_id,
      contactId: row.contact_id,
      attemptId: row.attempt_id,
      phoneNumber: row.phone_number,
      fromNumber: row.from_number,
      verdict: row.verdict,
      reason: row.reason,
      warnings: row.warnings,
      bypass: row.bypass,
      nextEligibleAt: row.next_eligible_at,
    }));
  }

  async ratios() {
    const { settings } = await this.settings.get();
    return allCliRatios(this.pool, this.organizationId, settings);
  }

  async export(filter: ExportFilter) {
    const { version } = await this.settings.get();
    return complianceExport(this.pool, this.organizationId, filter, version);
  }

  evidence(phoneNumber: string, date: Date) {
    return evidencePacket(this.pool, this.organizationId, phoneNumber, date);
  }

  /** The dispatcher's post-call sweep: dispositions into the ledger and their side effects. */
  applyDispositions(lookup: DispositionLookup, now?: Date): Promise<number> {
    return this.dispositions.run(lookup, now);
  }
}
