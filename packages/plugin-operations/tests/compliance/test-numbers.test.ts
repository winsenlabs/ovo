import { describe, expect, it } from 'vitest';
import type { CompliancePolicy } from '../../src/index.ts';
import {
  HOUR,
  now,
  recipient,
  allDay,
  settingsWith,
  facts,
  service,
  judge,
} from './evaluate-support.ts';

describe("the operator's test numbers", () => {
  it("skips registration checks for the operator's own test numbers, never suppressions", () => {
    const settings = settingsWith({ testNumbers: [recipient], autodialerIntimation: undefined });
    const unregistered = facts({ cli: undefined });
    expect(judge({ version: 1 }, unregistered, settings)).toEqual({
      verdict: 'allow',
      warnings: [],
      bypass: 'test_number',
      capsExempt: true,
    });
    expect(
      judge(service, facts({ suppression: { source: 'opt_out', scope: 'all' } }), settings),
    ).toMatchObject({ reason: 'suppressed' });
    const capped = settingsWith({
      testNumbers: [recipient],
      caps: { service: { attempts: { per24h: 1 } } },
      enforcement: { testNumberCaps: 'enforce' },
    });
    expect(
      judge(service, facts({ ledger: [{ authorizedAt: now, connected: false }] }), capped),
    ).toMatchObject({ verdict: 'defer', reason: 'recipient_attempt_cap' });
  });

  // Wave 7 review: one answered founder test call used to block the next for 24 hours
  // (`recipient_connected_cap`) and any retry within 2 hours (`min_gap`), even for recovery.
  it('lets a test number be called again straight after an answered call, inside the window', () => {
    const settings = settingsWith({
      testNumbers: [recipient],
      enforcement: { series: 'warn' },
      // The [BP] defaults: 1 conversation a day and a 2-hour gap for service and recovery.
      caps: {},
      windows: {
        service: allDay,
        rbi_recovery: { rules: [{ start: '08:00', end: '19:00' }] },
      },
    });
    const answered = facts({
      ledger: [{ authorizedAt: new Date(now.getTime() - 20 * 60_000), connected: true }],
    });
    for (const policy of [
      { ...service, manual: true },
      { ...service, purpose: 'rbi_recovery', manual: true },
    ] as CompliancePolicy[])
      expect(judge(policy, answered, settings)).toEqual({
        verdict: 'allow',
        warnings: [],
        bypass: 'test_number',
        capsExempt: true,
      });
    // Windows still apply: 20:00 IST is past the recovery overlay.
    const evening = new Date('2026-10-07T14:30:00Z');
    expect(
      judge({ ...service, purpose: 'rbi_recovery' }, answered, settings, evening),
    ).toMatchObject({ verdict: 'defer', reason: 'outside_calling_hours' });
    // So does the caller number's pacing.
    const paced = facts({ cliBlockedUntil: new Date(now.getTime() + HOUR) });
    expect(judge(service, paced, settings)).toMatchObject({
      verdict: 'defer',
      reason: 'cli_velocity_limit',
    });
    // A customer's number with the same history is still capped.
    const customer = '+919812345679';
    expect(judge(service, answered, settings, now, customer)).toMatchObject({
      verdict: 'defer',
      reason: 'recipient_connected_cap',
    });
    // And `enforce` caps test numbers too.
    const enforced = settingsWith({
      testNumbers: [recipient],
      enforcement: { series: 'warn', testNumberCaps: 'enforce' },
      caps: {},
    });
    expect(judge(service, answered, enforced)).toMatchObject({
      verdict: 'defer',
      bypass: 'test_number',
      reason: 'recipient_connected_cap',
    });
  });
});
