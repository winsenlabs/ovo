import type { Pool } from 'pg';
import { CampaignAdminService } from './campaign-admin.ts';
import { CampaignAdmissionService } from './campaign-admission.ts';
import { CampaignEventService } from './campaign-events.ts';
import type {
  AttemptTerminalStatus,
  CampaignCommandResult,
  CampaignConfig,
  CampaignContactInput,
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

  constructor(pool: Pool, organizationId: string) {
    this.admin = new CampaignAdminService(pool, organizationId);
    this.admission = new CampaignAdmissionService(pool, organizationId);
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

  suppress(phoneNumber: string, reason: string): Promise<void> {
    return this.admin.suppress(phoneNumber, reason);
  }

  unsuppress(phoneNumber: string): Promise<boolean> {
    return this.admin.unsuppress(phoneNumber);
  }

  listSuppressions(limit = 25, afterPhone?: string): Promise<SuppressionRecord[]> {
    return this.admin.listSuppressions(limit, afterPhone);
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
