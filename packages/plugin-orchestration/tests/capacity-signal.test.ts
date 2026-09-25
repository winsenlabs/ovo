import { describe, expect, it } from 'vitest';
import { computeCapacitySignal, type CapacitySignalInput } from '../src/capacity-signal.ts';

function fixture(): CapacitySignalInput {
  return {
    nowMs: 1_000_000,
    observedAtMs: 999_999,
    maxMetricAgeMs: 15_000,
    counts: { readyIdle: 1, reserved: 1, active: 2, starting: 3, draining: 1, total: 8 },
    eligibleDueJobs: 4,
    admissionHorizon: 2,
    campaigns: [],
    inboundEnabled: false,
    inboundWarmFloor: 2,
    configuredMax: 100,
    carrierConcurrency: 100,
    providerConcurrency: 100,
    spendPermitted: 100,
    provisionedTasks: 9,
    oldestEligibleJobAgeSeconds: 5,
  };
}

describe('computeCapacitySignal', () => {
  it('counts owned commitments and bounded due work once, not starting tasks', () => {
    expect(computeCapacitySignal(fixture())).toMatchObject({
      requiredSlots: 5,
      busySlots: 3,
      eligibleJobs: 4,
      provisionedTasks: 9,
    });
  });

  it('does not request fewer slots than active and reserved when a quota drops', () => {
    expect(computeCapacitySignal({ ...fixture(), configuredMax: 1 })).toMatchObject({
      requiredSlots: 3,
      limitingQuota: 'configured',
    });
  });

  it('applies the inbound floor only when inbound is enabled', () => {
    expect(computeCapacitySignal({ ...fixture(), eligibleDueJobs: 0 })?.requiredSlots).toBe(3);
    expect(computeCapacitySignal({ ...fixture(), eligibleDueJobs: 0, inboundEnabled: true })?.requiredSlots).toBe(5);
  });

  it('prewarms only within the future lead window and admits due demand separately', () => {
    const base = fixture();
    const campaign = { running: false, scheduledAtMs: base.nowMs + 600_000, maxConcurrency: 4, dueQueuedContacts: 3, alreadyAdmitted: 1, contacts: 5 };
    expect(computeCapacitySignal({ ...base, eligibleDueJobs: 0, campaigns: [campaign] })?.requiredSlots).toBe(7);
    expect(computeCapacitySignal({ ...base, eligibleDueJobs: 0, campaigns: [{ ...campaign, scheduledAtMs: base.nowMs + 600_001 }] })?.requiredSlots).toBe(3);
    expect(computeCapacitySignal({ ...base, eligibleDueJobs: 0, campaigns: [{ ...campaign, scheduledAtMs: base.nowMs }] })).toMatchObject({ requiredSlots: 5, campaignDemand: 2 });
  });

  it.each([
    ['carrier', { carrierConcurrency: 4 }],
    ['provider', { providerConcurrency: 4 }],
    ['spend', { spendPermitted: 1 }],
    ['configured', { configuredMax: 4 }],
  ] as const)('reports the %s limiting quota', (name, limits) => {
    expect(computeCapacitySignal({ ...fixture(), ...limits })).toMatchObject({ requiredSlots: 4, limitingQuota: name });
  });

  it('publishes nothing for stale, future, or inconsistent snapshots', () => {
    const base = fixture();
    expect(computeCapacitySignal({ ...base, observedAtMs: base.nowMs - 15_001 })).toBeUndefined();
    expect(computeCapacitySignal({ ...base, observedAtMs: base.nowMs + 1 })).toBeUndefined();
    expect(computeCapacitySignal({ ...base, counts: { ...base.counts, total: 7 } })).toBeUndefined();
    expect(computeCapacitySignal({ ...base, counts: { ...base.counts, active: -1 } })).toBeUndefined();
  });
});
