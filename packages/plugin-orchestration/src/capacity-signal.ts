import type { CapacitySignal } from '@winsendotai/ovo-contracts';

export interface CampaignCapacityDemand {
  running: boolean;
  scheduledAtMs: number;
  maxConcurrency: number;
  dueQueuedContacts: number;
  alreadyAdmitted: number;
  contacts: number;
}

export interface CapacitySignalInput {
  nowMs: number;
  observedAtMs: number;
  maxMetricAgeMs: number;
  counts: {
    readyIdle: number;
    reserved: number;
    active: number;
    starting: number;
    draining: number;
    total: number;
  };
  eligibleDueJobs: number;
  admissionHorizon: number;
  campaigns: readonly CampaignCapacityDemand[];
  prewarmLeadSeconds?: number;
  inboundEnabled: boolean;
  inboundWarmFloor: number;
  configuredMax: number;
  carrierConcurrency: number;
  providerConcurrency: number;
  spendPermitted: number;
  provisionedTasks: number;
  oldestEligibleJobAgeSeconds: number;
}

function natural(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** The dispatcher publishes demand; Application Auto Scaling alone changes desired count. */
export function computeCapacitySignal(input: CapacitySignalInput): CapacitySignal | undefined {
  const { counts } = input;
  const parts = [counts.readyIdle, counts.reserved, counts.active, counts.starting, counts.draining];
  const numbers = [
    input.nowMs,
    input.observedAtMs,
    input.maxMetricAgeMs,
    input.eligibleDueJobs,
    input.admissionHorizon,
    input.inboundWarmFloor,
    input.configuredMax,
    input.carrierConcurrency,
    input.providerConcurrency,
    input.spendPermitted,
    input.provisionedTasks,
    input.oldestEligibleJobAgeSeconds,
    counts.total,
    ...parts,
  ];
  if (
    !numbers.every(natural) ||
    input.maxMetricAgeMs === 0 ||
    input.observedAtMs > input.nowMs ||
    input.nowMs - input.observedAtMs > input.maxMetricAgeMs ||
    parts.reduce((sum, part) => sum + part, 0) !== counts.total
  ) return undefined;

  const leadSeconds = input.prewarmLeadSeconds ?? 600;
  if (!natural(leadSeconds)) return undefined;
  let campaignDemand = 0;
  let prewarm = 0;
  for (const campaign of input.campaigns) {
    if (![
      campaign.scheduledAtMs,
      campaign.maxConcurrency,
      campaign.dueQueuedContacts,
      campaign.alreadyAdmitted,
      campaign.contacts,
    ].every(natural)) return undefined;
    if (campaign.running || campaign.scheduledAtMs <= input.nowMs) {
      campaignDemand += Math.max(
        0,
        Math.min(campaign.maxConcurrency, campaign.dueQueuedContacts) - campaign.alreadyAdmitted,
      );
    } else if (campaign.scheduledAtMs <= input.nowMs + leadSeconds * 1000) {
      prewarm += Math.min(campaign.maxConcurrency, campaign.contacts);
    }
  }
  const busySlots = counts.active + counts.reserved;
  const quota = [
    ['configured', input.configuredMax],
    ['carrier', input.carrierConcurrency],
    ['provider', input.providerConcurrency],
    ['spend', input.spendPermitted + busySlots],
  ] as const;
  const [limitingQuota, hardMax] = quota.reduce((lowest, item) =>
    item[1] < lowest[1] ? item : lowest,
  );
  const jobs = Math.min(input.eligibleDueJobs, input.admissionHorizon);
  const requested = busySlots + jobs + campaignDemand + prewarm +
    (input.inboundEnabled ? input.inboundWarmFloor : 0);
  return {
    requiredSlots: Math.max(busySlots, Math.min(hardMax, requested)),
    provisionedTasks: input.provisionedTasks,
    busySlots,
    readyIdleSlots: counts.readyIdle,
    eligibleJobs: input.eligibleDueJobs,
    campaignDemand,
    oldestEligibleJobAgeSeconds: input.oldestEligibleJobAgeSeconds,
    limitingQuota: requested > hardMax ? limitingQuota : undefined,
    at: new Date(input.nowMs),
  };
}
