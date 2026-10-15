import { humaniseEnum } from '../../lib/status';

/** The compliance API's records (contracts workspace-compliance.ts), typed structurally. */
export interface ComplianceSettings {
  sender: { legalName?: string; dltPrincipalEntityId?: string; regulator: string };
  autodialerIntimation?: {
    submittedAt: string;
    oap: string;
    objective: string;
    documentRef: string;
  };
  enforcement: {
    series: 'refuse' | 'warn';
    a2pDeclarationRequiredFrom: string;
    abandonedBreaker: 'enforce' | 'monitor';
    recoveryCapsAreFloor: boolean;
    testNumberCaps: 'exempt' | 'enforce';
  };
  optOutScope: 'all' | 'promotional';
  testNumbers: string[];
  blackout: { dates: string[]; appliesTo: string[] };
  complaintSla: { ackHours: number; resolveDays: number; representBusinessDays: number };
  [other: string]: unknown;
}

export interface SettingsRecord {
  settings: ComplianceSettings;
  version: number;
  updatedAt: string | null;
  rulePack: { id: string; version: string };
  providers: string[];
}

export interface CliNumber {
  phoneNumber: string;
  series: '140' | '1600' | '1601' | 'other';
  categories: string[];
  status: 'active' | 'suspended' | 'flagged' | 'retired';
  oap?: string;
  flagNote?: string;
}

export interface A2pDeclaration {
  id: string;
  rangeStart: string;
  rangeEnd: string;
  oap: string;
  reference: string;
  declaredAt: string;
  effectiveFrom: string;
  withdrawnAt?: string;
}

export interface Complaint {
  id: string;
  kind: string;
  phoneNumber?: string;
  cli?: string;
  receivedAt: string;
  summary?: string;
  status: 'open' | 'acknowledged' | 'represented' | 'resolved' | 'closed';
  ackDueAt?: string;
  resolveDueAt: string;
  overdue?: 'ack' | 'resolve';
}

export interface CliRatio {
  fromNumber: string;
  attempts: number;
  abandonedRatio: number;
  silentRatio: number;
  level: 'ok' | 'warn' | 'stop';
}

export interface ConsentRecord {
  id: string;
  principalEntity: string;
  purpose: string;
  category: string;
  basis: string;
  evidenceRef: string;
  obtainedAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

/** An API failure as one line for the operator. */
export function failureText(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

// `humaniseEnum` title-cases a short all-lowercase token as a word ("Ucc"), not an acronym,
// because its acronym heuristic only fires on already-uppercase input. Complaint kinds carry a
// couple of real acronyms (TRAI's "UCC" - unsolicited commercial communication), so this keeps
// those distinct from the generic snake_case humaniser instead of patching the shared one for
// every other screen that calls it.
const KIND_ACRONYMS: Record<string, string> = { ucc: 'UCC' };

/** A complaint `kind` for display: humanised, with known regulatory acronyms kept upper-case. */
export function complaintKindLabel(kind: string): string {
  return KIND_ACRONYMS[kind.toLowerCase()] ?? humaniseEnum(kind);
}

/** The time left until a deadline, or how late it is, in hours or days. */
export function dueLabel(due: string, now = Date.now()): string {
  const hours = Math.round((Date.parse(due) - now) / 3_600_000);
  const amount =
    Math.abs(hours) >= 48 ? `${Math.round(Math.abs(hours) / 24)} d` : `${Math.abs(hours)} h`;
  return hours < 0 ? `${amount} overdue` : `due in ${amount}`;
}
