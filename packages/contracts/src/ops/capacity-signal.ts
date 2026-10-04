/** What the dispatcher publishes. Application Auto Scaling is the only writer of desired count (§10.1). */
export interface CapacitySignal {
  requiredSlots: number;
  provisionedTasks: number;
  busySlots: number;
  readyIdleSlots: number;
  eligibleJobs: number;
  campaignDemand: number;
  oldestEligibleJobAgeSeconds: number;
  limitingQuota?: string;
  at: Date;
}

/** Capability `capacity.signal`. */
export interface CapacitySignalPublisher {
  publish(signal: CapacitySignal): Promise<void>;
  last?(): CapacitySignal | undefined;
}

export const CAPACITY_METRIC_NAMES = Object.freeze({
  namespace: 'OVO/Capacity',
  required: 'RequiredSlots',
  provisioned: 'ProvisionedTasks',
  busy: 'BusySlots',
  readyIdle: 'ReadyIdleSlots',
  eligible: 'EligibleJobs',
  campaign: 'CampaignDemand',
  oldestAge: 'OldestEligibleJobAgeSeconds',
} as const);
