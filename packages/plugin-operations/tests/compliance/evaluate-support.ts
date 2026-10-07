// The evaluator's test inputs: a configured Indian workspace judged at a fixed instant.
import { WorkspaceCompliance } from '@winsendotai/ovo-contracts';
import {
  GENERIC_PACK,
  IN_TCCCPR_2026_10,
  evaluateDial,
  type CompliancePolicy,
  type RecipientFacts,
} from '../../src/index.ts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** Wednesday 7 October 2026, noon in India. */
export const now = new Date('2026-10-07T06:30:00Z');
export const recipient = '+919812345678';
export const allDay = { rules: [{ start: '00:00', end: '23:59' }] };
export const intimation = {
  submittedAt: '2026-09-01',
  oap: 'Example telco',
  objective: 'EMI reminders',
  documentRef: 'OAP/2026/17',
};
export const settingsWith = (extra: Record<string, unknown> = {}) =>
  WorkspaceCompliance.parse({
    autodialerIntimation: intimation,
    windows: { service: allDay, promotional: { rules: [{ start: '10:00', end: '21:00' }] } },
    caps: { service: {}, promotional: {} },
    ...extra,
  });
export const facts = (extra: Partial<RecipientFacts> = {}): RecipientFacts => ({
  openComplaint: false,
  consents: [],
  ledger: [],
  cli: { series: '1600', categories: ['service', 'transactional'], status: 'active' },
  a2pDeclared: false,
  breakerTripped: false,
  ...extra,
});
export const service: CompliancePolicy = { version: 1, category: 'service' };
export const judge = (
  policy: CompliancePolicy,
  recipientFacts: RecipientFacts,
  settings = settingsWith(),
  at = now,
  to = recipient,
) =>
  evaluateDial({
    pack: to.startsWith('+91') ? IN_TCCCPR_2026_10 : GENERIC_PACK,
    settings,
    policy,
    recipient: to,
    facts: recipientFacts,
    now: at,
  });
