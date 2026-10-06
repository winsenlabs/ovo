import type { ContactState } from './contact-state.ts';

export type DoNotCallSource = 'manual' | 'import' | 'opt_out';

export interface SuppressionRecord {
  phoneNumber: string;
  reason: string;
  /** Who listed it: an operator, a bulk import, or the caller asking not to be called (opt-out). */
  source: DoNotCallSource;
  /** The call in which the caller opted out. */
  callId?: string;
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
}
