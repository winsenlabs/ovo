export type WorkerState = 'readyIdle' | 'reserved' | 'active' | 'starting' | 'draining';
export type InboundOverflow = 'busy' | 'wait' | 'callback' | 'human';

export interface CapacityCounts {
  readyIdle: number;
  reserved: number;
  active: number;
  starting: number;
  draining: number;
  total: number;
}

export interface CapacityInput {
  nowMs: number;
  observedAtMs: number;
  maxMetricAgeMs: number;
  counts: CapacityCounts;
  currentDesired: number;
  eligibleUnclaimed: number;
  permittedNewStartsInHorizon: number;
  inbound: { enabled: boolean; warmIdleFloor: number; overflow: InboundOverflow };
  limits: {
    configuredMin: number;
    configuredMax: number;
    carrierConcurrency: number;
    providerConcurrency: number;
    awsTaskLimit: number;
    spendPermittedStarts: number;
  };
  maxScaleOutStep: number;
  maxScaleInStep: number;
}

export interface CapacityDecision {
  desiredCount: number;
  admissibleNewCalls: number;
  writeDesiredCount: boolean;
  failClosed: boolean;
  limitingQuota?: 'carrier' | 'provider' | 'aws' | 'spend' | 'configured';
  overflow: InboundOverflow;
  reason: string;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function invalidCounts(counts: CapacityCounts): boolean {
  const parts = [
    counts.readyIdle,
    counts.reserved,
    counts.active,
    counts.starting,
    counts.draining,
  ];
  return (
    !parts.every(nonNegativeInteger) ||
    !nonNegativeInteger(counts.total) ||
    parts.reduce((sum, value) => sum + value, 0) !== counts.total
  );
}

/** Pure one-slot-per-worker policy. It never uses raw approximate SQS depth as ownership truth. */
export function decideCapacity(input: CapacityInput): CapacityDecision {
  const stale =
    input.nowMs - input.observedAtMs > input.maxMetricAgeMs || input.observedAtMs > input.nowMs;
  const invalid = invalidCounts(input.counts);
  const invalidPolicy =
    ![
      input.currentDesired,
      input.eligibleUnclaimed,
      input.permittedNewStartsInHorizon,
      input.inbound.warmIdleFloor,
      input.limits.configuredMin,
      input.limits.configuredMax,
      input.limits.carrierConcurrency,
      input.limits.providerConcurrency,
      input.limits.awsTaskLimit,
      input.limits.spendPermittedStarts,
      input.maxScaleOutStep,
      input.maxScaleInStep,
    ].every(nonNegativeInteger) || input.maxMetricAgeMs <= 0;
  if (stale || invalid || invalidPolicy) {
    return {
      desiredCount: input.currentDesired,
      admissibleNewCalls: 0,
      writeDesiredCount: false,
      failClosed: true,
      overflow: input.inbound.overflow,
      reason: stale
        ? 'metrics-stale-admission-closed'
        : invalid
          ? 'worker-counts-not-mutually-exclusive'
          : 'capacity-configuration-invalid',
    };
  }

  const quotaPairs = [
    ['configured', input.limits.configuredMax],
    ['carrier', input.limits.carrierConcurrency],
    ['provider', input.limits.providerConcurrency],
    ['aws', input.limits.awsTaskLimit],
    ['spend', input.limits.spendPermittedStarts + input.counts.active + input.counts.reserved],
  ] as const;
  const [limitingQuota, hardMaximum] = quotaPairs.reduce((lowest, entry) =>
    entry[1] < lowest[1] ? entry : lowest,
  );
  const commitments = input.counts.active + input.counts.reserved;
  const warmFloor = input.inbound.enabled ? input.inbound.warmIdleFloor : 0;
  const demand = Math.min(input.eligibleUnclaimed, input.permittedNewStartsInHorizon);
  const unclampedRequired = commitments + demand + warmFloor;
  // A lowered quota blocks new admission but never asks ECS to scale below already owned commitments.
  const boundedRequired = Math.max(
    commitments,
    Math.min(hardMaximum, Math.max(input.limits.configuredMin, unclampedRequired)),
  );

  let desiredCount = boundedRequired;
  if (boundedRequired > input.currentDesired) {
    desiredCount = Math.min(boundedRequired, input.currentDesired + input.maxScaleOutStep);
  } else if (boundedRequired < input.currentDesired) {
    desiredCount = Math.max(boundedRequired, input.currentDesired - input.maxScaleInStep);
  }

  // Starting tasks are already represented by current desired count; the absolute target above does not add them again.
  const remainingQuota = Math.max(0, hardMaximum - commitments);
  const admissibleNewCalls = Math.max(0, Math.min(input.counts.readyIdle, remainingQuota));
  const constrained = unclampedRequired > hardMaximum;
  return {
    desiredCount,
    admissibleNewCalls,
    writeDesiredCount: desiredCount !== input.currentDesired,
    failClosed: false,
    limitingQuota: constrained ? limitingQuota : undefined,
    overflow: input.inbound.overflow,
    reason: constrained
      ? `bounded-by-${limitingQuota}`
      : input.currentDesired === 0 && desiredCount > 0
        ? 'scale-from-zero-demand-observed'
        : desiredCount > input.currentDesired
          ? 'bounded-scale-out'
          : desiredCount < input.currentDesired
            ? 'bounded-scale-in'
            : 'capacity-steady',
  };
}
