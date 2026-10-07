import type { SuppressionScope, SuppressionSource } from '@winsendotai/ovo-contracts';
import type { ContactState } from './contact-state.ts';

export type DoNotCallSource = SuppressionSource;
export type { SuppressionScope };

export interface SuppressionRecord {
  phoneNumber: string;
  reason: string;
  /**
   * Who listed it: an operator, a bulk import, the caller asking not to be called (opt-out), a DND
   * or DLT revocation, a complaint, a wrong number or a regulator.
   */
  source: DoNotCallSource;
  /** The call in which the caller opted out. */
  callId?: string;
  /** Every call, promotional calls only, or one purpose (a wrong number). */
  scope: SuppressionScope;
  purpose?: string;
  /** An opt-out cannot be removed before this instant (90 days, TCCCPR R13). */
  lockUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignContactRecord {
  id: string;
  sourceRow: number;
  phoneNumber: string;
  externalId?: string;
  variables: Record<string, string>;
  state: ContactState;
  /** Why the compliance gate refused or deferred this contact, when it did. */
  complianceReason?: string;
}
