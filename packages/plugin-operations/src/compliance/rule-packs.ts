import type {
  CampaignConsentBasis,
  ComplianceCategory,
  CompliancePurpose,
  ComplianceRegulator,
} from '@winsendotai/ovo-contracts';

/**
 * Jurisdiction rule packs (compliance spec 3.1): the floors configuration can only narrow. The
 * numbers are code, not config: changing one is a code change with a test and a version bump.
 * Not legal advice; each value cites the spec rule it implements.
 */
export type CliSeries = '140' | '1600' | '1601' | 'other';

export interface PackWindow {
  start: string;
  end: string;
  days?: number[];
}

export interface CategoryRules {
  series: readonly CliSeries[];
  window: PackWindow | null;
  consent: readonly CampaignConsentBasis[];
}

export interface RulePack {
  id: string;
  version: string;
  /** Every window is judged in the recipient's time when set (G5). */
  recipientTimezone?: string;
  /** Null for a pack without call categories (no series, consent or preference rules). */
  categories: Readonly<Record<ComplianceCategory, CategoryRules>> | null;
  purposeOverlays: Readonly<Partial<Record<CompliancePurpose, { window: PackWindow }>>>;
  sectorSeries: Readonly<Partial<Record<ComplianceRegulator, CliSeries>>>;
  reconsentCooldownDays: number;
  explicitServiceConsentDays: number;
  inquiryRelationshipDays: number;
  applicationRelationshipDays: number;
  transactionWindowMinutes: number;
  a2pDeclarationRequiredFrom: string | null;
}

export const IN_TCCCPR_2026_10: RulePack = Object.freeze<RulePack>({
  id: 'IN-TCCCPR',
  version: '2026.10.1',
  recipientTimezone: 'Asia/Kolkata',
  categories: {
    // R2 140-series only; R15 default time bands leave 10:00-21:00 deliverable; R9 consent or DND.
    promotional: {
      series: ['140'],
      window: { start: '10:00', end: '21:00' },
      consent: ['explicit_registered', 'explicit_legacy_registered', 'preference_allows'],
    },
    // R3/R4 1600/1601; R16 no TRAI time limit; R11/R12 inferred, 7-day explicit, inquiries.
    service: {
      series: ['1600', '1601'],
      window: null,
      consent: ['inferred_relationship', 'explicit_service_7d', 'inquiry_7d', 'application_3m'],
    },
    transactional: { series: ['1600', '1601'], window: null, consent: ['transaction_30min'] },
  },
  // R17: RBI-regulated entities and their agents never call borrowers before 08:00 or after 19:00.
  purposeOverlays: { rbi_recovery: { window: { start: '08:00', end: '19:00' } } },
  // R3 (BFSI and Government on 1600, deadlines passed) and R4 (1601 Phase I sectors).
  sectorSeries: {
    rbi: '1600',
    sebi: '1600',
    irdai: '1600',
    pfrda: '1600',
    government: '1600',
    utilities: '1601',
    logistics: '1601',
  },
  reconsentCooldownDays: 90, // R13
  explicitServiceConsentDays: 7, // R11
  inquiryRelationshipDays: 7, // R12
  applicationRelationshipDays: 90, // R12: an application within the prior 3 months
  transactionWindowMinutes: 30, // TCCCPR 2025 "transactional": within 30 minutes of the trigger
  // R7, Third Amendment Reg 4 (+60 days from gazette, ~17 Nov 2026; confirm the date, Q2).
  a2pDeclarationRequiredFrom: '2026-11-17',
});

/** Numbers outside India: only the configured windows, caps and the do-not-call list apply. */
export const GENERIC_PACK: RulePack = Object.freeze<RulePack>({
  id: 'GENERIC',
  version: '2026.10.1',
  categories: null,
  purposeOverlays: {},
  sectorSeries: {},
  reconsentCooldownDays: 90,
  explicitServiceConsentDays: 7,
  inquiryRelationshipDays: 7,
  applicationRelationshipDays: 90,
  transactionWindowMinutes: 30,
  a2pDeclarationRequiredFrom: null,
});

export function packFor(recipient: string): RulePack {
  return recipient.startsWith('+91') ? IN_TCCCPR_2026_10 : GENERIC_PACK;
}

/**
 * The designated series a caller number belongs to, from its E.164 digits: 140xxxxxxx for
 * promotional calls (R2), 1600xxxxxx and 1601xxxxxx for service and transactional calls (R3, R4).
 */
export function seriesOf(phoneNumber: string): CliSeries {
  if (!phoneNumber.startsWith('+91')) return 'other';
  const national = phoneNumber.slice(3);
  if (national.length !== 10) return 'other';
  if (national.startsWith('1600')) return '1600';
  if (national.startsWith('1601')) return '1601';
  if (national.startsWith('140')) return '140';
  return 'other';
}
