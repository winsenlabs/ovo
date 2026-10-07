import { describe, expect, it } from 'vitest';
import { consentExpiry, type CompliancePolicy } from '../../src/index.ts';
import {
  HOUR,
  DAY,
  now,
  recipient,
  intimation,
  settingsWith,
  facts,
  service,
  judge,
} from './evaluate-support.ts';

describe('the dial-path evaluator', () => {
  it('allows a registered service call with an inferred relationship', () => {
    expect(judge(service, facts())).toEqual({ verdict: 'allow', warnings: [] });
  });

  it('needs a call category for +91 numbers, and none elsewhere', () => {
    expect(judge({ version: 1 }, facts())).toMatchObject({
      verdict: 'refuse',
      reason: 'category_missing',
    });
    expect(judge({ version: 1 }, facts(), settingsWith(), now, '+14155550100')).toMatchObject({
      verdict: 'allow',
    });
  });

  describe('caller-ID series (R2-R5)', () => {
    const promotional: CompliancePolicy = {
      version: 1,
      category: 'promotional',
      consentBasis: 'preference_allows',
    };
    const fresh = { result: 'allowed' as const, checkedAt: now, provider: 'manual-upload' };

    it('refuses promotional calls from a 1600 number', () => {
      expect(judge(promotional, facts({ preference: fresh }))).toMatchObject({
        reason: 'series_category_mismatch',
      });
      const from140 = facts({
        preference: fresh,
        cli: { series: '140', categories: ['promotional'], status: 'active' },
      });
      expect(judge(promotional, from140)).toMatchObject({ verdict: 'allow' });
    });

    it("refuses an RBI entity's service call from 1601 or a 10-digit number", () => {
      const rbi = settingsWith({ sender: { regulator: 'rbi' } });
      for (const series of ['1601', 'other'] as const)
        expect(
          judge(
            service,
            facts({ cli: { series, categories: ['service'], status: 'active' } }),
            rbi,
          ),
        ).toMatchObject({ verdict: 'refuse', reason: 'series_regulator_mismatch' });
      const utilities = settingsWith({ sender: { regulator: 'utilities' } });
      const from1601 = facts({
        cli: { series: '1601', categories: ['service'], status: 'active' },
      });
      expect(judge(service, from1601, utilities)).toMatchObject({ verdict: 'allow' });
    });

    it('refuses an unregistered caller number, or dials and warns in warn mode', () => {
      expect(judge(service, facts({ cli: undefined }))).toMatchObject({
        reason: 'from_number_not_registered',
      });
      const warn = settingsWith({ enforcement: { series: 'warn' } });
      const tenDigit = facts({
        cli: { series: 'other', categories: ['service'], status: 'active' },
      });
      expect(judge(service, tenDigit, warn)).toEqual({
        verdict: 'allow',
        warnings: ['series_category_mismatch'],
      });
    });

    it('never dials from a flagged or suspended caller number, whatever the mode', () => {
      const warn = settingsWith({ enforcement: { series: 'warn' } });
      for (const [status, reason] of [
        ['flagged', 'cli_flagged'],
        ['suspended', 'cli_suspended'],
      ] as const)
        expect(
          judge(service, facts({ cli: { series: '1600', categories: ['service'], status } }), warn),
        ).toMatchObject({ verdict: 'refuse', reason });
    });
  });

  describe('A2P declaration and autodialler intimation (R6, R7)', () => {
    it('needs the written intimation before the Third Amendment date', () => {
      expect(
        judge(service, facts(), settingsWith({ autodialerIntimation: undefined })),
      ).toMatchObject({ reason: 'autodialer_intimation_missing' });
    });

    it('needs an effective A2P declaration from 17 November 2026 IST', () => {
      const commenced = new Date('2026-11-16T18:30:00Z');
      expect(
        judge(service, facts(), settingsWith(), new Date(commenced.getTime() - 5 * 60_000)),
      ).toMatchObject({
        verdict: 'allow',
      });
      expect(judge(service, facts(), settingsWith(), commenced)).toMatchObject({
        reason: 'a2p_not_declared',
      });
      expect(judge(service, facts({ a2pDeclared: true }), settingsWith(), commenced)).toMatchObject(
        {
          verdict: 'allow',
        },
      );
      const early = settingsWith({ enforcement: { a2pDeclarationRequiredFrom: '2026-10-01' } });
      expect(judge(service, facts(), early)).toMatchObject({ reason: 'a2p_not_declared' });
    });
  });

  describe('consent (R9-R12)', () => {
    const obtainedAt = new Date(now.getTime() - 3 * DAY);
    const explicit: CompliancePolicy = { ...service, consentBasis: 'explicit_service_7d' };
    const consent = {
      id: 'consent-1',
      basis: 'explicit_service_7d' as const,
      category: 'service',
      principalEntity: 'Example Bank',
      purpose: 'loan servicing',
      obtainedAt,
      expiresAt: consentExpiry('explicit_service_7d', obtainedAt),
    };

    it('holds a 7-day service consent for exactly 7 days', () => {
      const expiry = obtainedAt.getTime() + 7 * DAY;
      const before = new Date(expiry - HOUR);
      expect(judge(explicit, facts({ consents: [consent] }), settingsWith(), before)).toEqual({
        verdict: 'allow',
        warnings: [],
        consentId: 'consent-1',
      });
      expect(
        judge(explicit, facts({ consents: [consent] }), settingsWith(), new Date(expiry)),
      ).toMatchObject({
        reason: 'consent_expired',
      });
    });

    it('refuses revoked, missing and out-of-scope consent', () => {
      expect(judge(explicit, facts({ consents: [{ ...consent, revokedAt: now }] }))).toMatchObject({
        reason: 'consent_revoked',
      });
      expect(judge(explicit, facts())).toMatchObject({ reason: 'no_consent' });
      const scoped = { ...explicit, consentScope: { principalEntity: 'Other Bank' } };
      expect(judge(scoped, facts({ consents: [consent] }))).toMatchObject({
        reason: 'consent_scope_mismatch',
      });
      // An inferred relationship needs no row, but a revoked one on record still stops it.
      expect(judge(service, facts({ consents: [{ ...consent, revokedAt: now }] }))).toMatchObject({
        reason: 'consent_revoked',
      });
    });

    it('refuses a consent basis the category does not allow', () => {
      expect(judge({ ...service, consentBasis: 'explicit_registered' }, facts())).toMatchObject({
        reason: 'consent_basis_not_allowed',
      });
    });
  });

  describe('DND / NCPR scrub (R9, R14)', () => {
    const promotional: CompliancePolicy = {
      version: 1,
      category: 'promotional',
      consentBasis: 'preference_allows',
    };
    const from140 = { series: '140' as const, categories: ['promotional'], status: 'active' };
    const scrub = (result: 'allowed' | 'blocked' | 'fully_blocked' | 'unknown', age = 0) => ({
      result,
      checkedAt: new Date(now.getTime() - age),
      provider: 'manual-upload',
      ref: 'RTM-1',
    });

    it('fails closed for promotional calls without a fresh allowed result', () => {
      for (const preference of [undefined, scrub('unknown'), scrub('allowed', 25 * HOUR)])
        expect(judge(promotional, facts({ cli: from140, preference }))).toMatchObject({
          reason: 'preference_unverified',
        });
      expect(
        judge(promotional, facts({ cli: from140, preference: scrub('blocked') })),
      ).toMatchObject({
        reason: 'preference_blocked',
      });
      expect(judge(promotional, facts({ cli: from140, preference: scrub('allowed') }))).toEqual({
        verdict: 'allow',
        warnings: [],
        preferenceRef: 'RTM-1',
      });
    });

    it('lets explicit registered consent override a DND block', () => {
      const consented = { ...promotional, consentBasis: 'explicit_registered' as const };
      const consent = {
        id: 'consent-2',
        basis: 'explicit_registered' as const,
        category: 'promotional',
        principalEntity: 'Example Bank',
        purpose: 'credit cards',
        obtainedAt: new Date(now.getTime() - 30 * DAY),
      };
      expect(
        judge(
          consented,
          facts({ cli: from140, consents: [consent], preference: scrub('blocked') }),
        ),
      ).toMatchObject({ verdict: 'allow', consentId: 'consent-2' });
    });

    it('ignores FULLY BLOCK for inferred service calls, but not for 7-day consent calls', () => {
      expect(judge(service, facts({ preference: scrub('fully_blocked') }))).toMatchObject({
        verdict: 'allow',
      });
      expect(
        judge(
          { ...service, consentBasis: 'explicit_service_7d' },
          facts({ preference: scrub('fully_blocked') }),
        ),
      ).toMatchObject({ verdict: 'refuse', reason: 'preference_blocked' });
    });
  });

  describe('per-recipient caps across campaigns (G9)', () => {
    const attempt = (hoursAgo: number, connected = false) => ({
      authorizedAt: new Date(now.getTime() - hoursAgo * HOUR),
      connected,
    });

    it('defers the fourth attempt in 24 hours until the oldest one rolls off', () => {
      const capped = settingsWith({ caps: { service: { attempts: { per24h: 3 } } } });
      const ledger = [attempt(1), attempt(5), attempt(20)];
      expect(judge(service, facts({ ledger }), capped)).toMatchObject({
        verdict: 'defer',
        reason: 'recipient_attempt_cap',
        details: { window: '24h', limit: 3 },
        nextEligibleAt: new Date(now.getTime() + 4 * HOUR),
      });
      expect(judge(service, facts({ ledger: ledger.slice(1) }), capped)).toMatchObject({
        verdict: 'allow',
      });
    });

    it('caps conversations and keeps a minimum gap between attempts', () => {
      const capped = settingsWith({
        caps: { service: { connected: { per24h: 1 }, minGapMinutes: 120 } },
      });
      expect(judge(service, facts({ ledger: [attempt(3, true)] }), capped)).toMatchObject({
        reason: 'recipient_connected_cap',
        nextEligibleAt: new Date(now.getTime() + 21 * HOUR),
      });
      expect(judge(service, facts({ ledger: [attempt(1)] }), capped)).toMatchObject({
        reason: 'min_gap',
        nextEligibleAt: new Date(now.getTime() + HOUR),
      });
    });

    it('holds RBI recovery to 3 attempts a day even when settings allow more (Q4)', () => {
      const generous = settingsWith({
        caps: { rbi_recovery: { attempts: { per24h: 10 } } },
        windows: { rbi_recovery: { rules: [{ start: '08:00', end: '19:00' }] } },
      });
      const recovery = { ...service, purpose: 'rbi_recovery' as const };
      const ledger = [attempt(3), attempt(6), attempt(9)];
      expect(judge(recovery, facts({ ledger }), generous)).toMatchObject({
        reason: 'recipient_attempt_cap',
      });
    });

    it('cools a declined promotional number off for 30 days', () => {
      const promotional: CompliancePolicy = {
        version: 1,
        category: 'promotional',
        consentBasis: 'preference_allows',
      };
      const declined = facts({
        cli: { series: '140', categories: ['promotional'], status: 'active' },
        preference: { result: 'allowed', checkedAt: now, provider: 'manual-upload' },
        ledger: [{ ...attempt(240), outcome: 'refused', category: 'promotional' }],
      });
      expect(judge(promotional, declined)).toMatchObject({
        reason: 'refusal_cooloff',
        nextEligibleAt: new Date(now.getTime() - 240 * HOUR + 30 * DAY),
      });
    });

    it('slows a CLI outside the designated series to its velocity limit (R20)', () => {
      const warn = settingsWith({ enforcement: { series: 'warn' } });
      const until = new Date(now.getTime() + 10 * 60_000);
      const busy = facts({
        cli: { series: 'other', categories: ['service'], status: 'active' },
        cliBlockedUntil: until,
      });
      expect(judge(service, busy, warn)).toMatchObject({
        verdict: 'defer',
        reason: 'cli_velocity_limit',
        nextEligibleAt: until,
      });
    });
  });

  describe('suppressions, complaints and test numbers', () => {
    it('applies a do-not-call entry by its scope', () => {
      const promotionalOnly = facts({ suppression: { source: 'ncpr', scope: 'promotional' } });
      expect(judge(service, promotionalOnly)).toMatchObject({ verdict: 'allow' });
      const wrongNumber = facts({
        suppression: { source: 'wrong_number', scope: 'purpose', purpose: 'reminder' },
      });
      expect(judge({ ...service, purpose: 'reminder' }, wrongNumber)).toMatchObject({
        reason: 'suppressed',
        details: { source: 'wrong_number', scope: 'purpose' },
      });
      expect(judge({ ...service, purpose: 'onboarding' }, wrongNumber)).toMatchObject({
        verdict: 'allow',
      });
      expect(judge(service, facts({ openComplaint: true }))).toMatchObject({
        reason: 'complaint_open',
      });
      expect(judge(service, facts({ breakerTripped: true }))).toMatchObject({
        reason: 'abandoned_ratio_breaker',
      });
    });
  });
});
