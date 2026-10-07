import type { Pool } from 'pg';
import type { PreferenceProvider } from '@winsendotai/ovo-contracts';
import { CampaignAdminService } from './campaign-admin.ts';
import { CampaignAdmissionService } from './campaign-admission.ts';
import { CampaignEventService } from './campaign-events.ts';
import { ComplianceService } from './compliance/service.ts';
import { ComplianceSettingsStore } from './compliance/settings.ts';
import { DoNotCallService } from './do-not-call.ts';
import type {
  AttemptTerminalStatus,
  CampaignCommandResult,
  CampaignConfig,
  CampaignContactInput,
  CampaignContactRecord,
  CampaignCounters,
  CampaignRecord,
  ContactAdmission,
  DialAuthorizationResult,
  SuppressionRecord,
} from './types.ts';

export class CampaignService {
  private readonly admin: CampaignAdminService;
  private readonly admission: CampaignAdmissionService;
  private readonly events: CampaignEventService;
  /** The do-not-call list; `suppress`, `unsuppress` and `listSuppressions` are its older names. */
  readonly doNotCall: DoNotCallService;
  /** Compliance by configuration: settings, registries, consent, complaints and the dial gate. */
  readonly compliance: ComplianceService;

  constructor(
    pool: Pool,
    organizationId: string,
    preferenceProviders: readonly PreferenceProvider[] = [],
  ) {
    const settings = new ComplianceSettingsStore(pool, organizationId);
    this.doNotCall = new DoNotCallService(pool, organizationId, settings);
    this.compliance = new ComplianceService(
      pool,
      organizationId,
      this.doNotCall,
      settings,
      preferenceProviders,
    );
    this.admin = new CampaignAdminService(pool, organizationId);
    this.admission = new CampaignAdmissionService(pool, organizationId, this.compliance.gate);
    this.events = new CampaignEventService(pool, organizationId);
  }

  create(
    config: CampaignConfig,
    contacts: readonly CampaignContactInput[],
  ): Promise<CampaignRecord> {
    return this.admin.create(config, contacts);
  }

  addContacts(campaignId: string, contacts: readonly CampaignContactInput[]): Promise<number> {
    return this.admin.addContacts(campaignId, contacts);
  }

  get(id: string): Promise<CampaignRecord> {
    return this.admin.get(id);
  }

  list(limit = 25, afterId?: string): Promise<CampaignRecord[]> {
    return this.admin.list(limit, afterId);
  }

  command(
    id: string,
    command: 'pause' | 'resume' | 'cancel',
    expectedVersion: number,
  ): Promise<CampaignCommandResult> {
    return this.admin.command(id, command, expectedVersion);
  }

  patchConcurrency(
    id: string,
    expectedVersion: number,
    maxConcurrency: number,
  ): Promise<CampaignCommandResult> {
    return this.admin.patchConcurrency(id, expectedVersion, maxConcurrency);
  }

  listContacts(
    campaignId: string,
    limit = 25,
    afterSourceRow?: number,
  ): Promise<CampaignContactRecord[]> {
    return this.admin.listContacts(campaignId, limit, afterSourceRow);
  }

  suppress(phoneNumber: string, reason: string): Promise<void> {
    return this.doNotCall.add(phoneNumber, reason);
  }

  async unsuppress(phoneNumber: string): Promise<boolean> {
    return !!(await this.doNotCall.remove(phoneNumber));
  }

  listSuppressions(limit = 25, afterPhone?: string): Promise<SuppressionRecord[]> {
    return this.doNotCall.list(limit, afterPhone);
  }

  admit(
    campaignId: string,
    ownerId: string,
    leaseMs: number,
    requestedJobId?: string,
  ): Promise<ContactAdmission> {
    return this.admission.admit(campaignId, ownerId, leaseMs, requestedJobId);
  }

  authorizeDial(
    contactId: string,
    ownerId: string,
    ownerEpoch: number,
  ): Promise<DialAuthorizationResult> {
    return this.admission.authorizeDial(contactId, ownerId, ownerEpoch);
  }

  recordAttempt(
    attemptId: string,
    eventId: string,
    status: 'dialing' | 'connected' | AttemptTerminalStatus,
    occurredAt: Date,
    reason?: string,
  ): Promise<'applied' | 'duplicate' | 'ignored_terminal' | 'ignored_out_of_order'> {
    return this.events.recordAttempt(attemptId, eventId, status, occurredAt, reason);
  }

  counters(campaignId: string): Promise<CampaignCounters> {
    return this.events.counters(campaignId);
  }
}
