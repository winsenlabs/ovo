import { describe, expect, it } from 'vitest';
import { decideCapacity, type CapacityInput } from '../src/capacity.ts';

function baseline(overrides: Partial<CapacityInput> = {}): CapacityInput {
  return {
    nowMs: 10_000,
    observedAtMs: 9_900,
    maxMetricAgeMs: 1_000,
    counts: { readyIdle: 0, reserved: 0, active: 0, starting: 0, draining: 0, total: 0 },
    currentDesired: 0,
    eligibleUnclaimed: 4,
    permittedNewStartsInHorizon: 4,
    inbound: { enabled: false, warmIdleFloor: 0, overflow: 'callback' },
    limits: {
      configuredMin: 0,
      configuredMax: 20,
      carrierConcurrency: 20,
      providerConcurrency: 20,
      awsTaskLimit: 20,
      spendPermittedStarts: 20,
    },
    maxScaleOutStep: 5,
    maxScaleInStep: 1,
    ...overrides,
  };
}

describe('quota-aware capacity policy', () => {
  it('scales from zero through the independent dispatcher signal', () => {
    expect(decideCapacity(baseline())).toMatchObject({
      desiredCount: 4,
      writeDesiredCount: true,
      reason: 'scale-from-zero-demand-observed',
    });
  });

  it('fails closed when metrics are stale', () => {
    expect(decideCapacity(baseline({ observedAtMs: 1_000, currentDesired: 3 }))).toMatchObject({
      desiredCount: 3,
      admissibleNewCalls: 0,
      writeDesiredCount: false,
      failClosed: true,
      reason: 'metrics-stale-admission-closed',
    });
  });

  it('rejects overlapping worker-state counts', () => {
    const decision = decideCapacity(
      baseline({
        currentDesired: 3,
        counts: { readyIdle: 1, reserved: 1, active: 1, starting: 1, draining: 0, total: 3 },
      }),
    );
    expect(decision.reason).toBe('worker-counts-not-mutually-exclusive');
    expect(decision.failClosed).toBe(true);
  });

  it('maintains a warm inbound floor and names the overflow action', () => {
    const decision = decideCapacity(
      baseline({
        eligibleUnclaimed: 0,
        inbound: { enabled: true, warmIdleFloor: 3, overflow: 'human' },
      }),
    );
    expect(decision).toMatchObject({ desiredCount: 3, overflow: 'human' });
  });

  it('does not add starting tasks to absolute demand a second time', () => {
    const decision = decideCapacity(
      baseline({
        currentDesired: 4,
        counts: { readyIdle: 0, reserved: 0, active: 0, starting: 4, draining: 0, total: 4 },
      }),
    );
    expect(decision.desiredCount).toBe(4);
    expect(decision.writeDesiredCount).toBe(false);
  });

  it('clamps demand to the tightest provider quota', () => {
    const decision = decideCapacity(
      baseline({
        eligibleUnclaimed: 20,
        limits: { ...baseline().limits, providerConcurrency: 2 },
      }),
    );
    expect(decision).toMatchObject({
      desiredCount: 2,
      limitingQuota: 'provider',
      reason: 'bounded-by-provider',
    });
  });

  it('blocks new admission but preserves commitments when a quota drops', () => {
    const decision = decideCapacity(
      baseline({
        currentDesired: 6,
        counts: { readyIdle: 0, reserved: 2, active: 4, starting: 0, draining: 0, total: 6 },
        limits: { ...baseline().limits, carrierConcurrency: 2 },
      }),
    );
    expect(decision).toMatchObject({
      desiredCount: 6,
      admissibleNewCalls: 0,
      limitingQuota: 'carrier',
    });
  });

  it('fails closed for an invalid negative capacity configuration', () => {
    const decision = decideCapacity(
      baseline({ limits: { ...baseline().limits, configuredMax: -1 } }),
    );
    expect(decision).toMatchObject({
      failClosed: true,
      writeDesiredCount: false,
      reason: 'capacity-configuration-invalid',
    });
  });
});
