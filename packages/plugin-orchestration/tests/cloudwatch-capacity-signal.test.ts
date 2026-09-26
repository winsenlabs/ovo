import { describe, expect, it, vi } from 'vitest';
import { CAPACITY_METRIC_NAMES, type CapacitySignal } from '@winsendotai/ovo-contracts';
import { AwsCapacityMetricPublisher, type CloudWatchMetricClient } from '../src/aws.ts';
import { LogCapacitySignalPublisher } from '../src/capacity-signals.ts';

const signal: CapacitySignal = {
  requiredSlots: 8,
  provisionedTasks: 6,
  busySlots: 3,
  readyIdleSlots: 1,
  eligibleJobs: 5,
  campaignDemand: 2,
  oldestEligibleJobAgeSeconds: 12,
  at: new Date('2026-09-25T00:00:00Z'),
};

describe('capacity signal publishers', () => {
  it('sends one high-resolution CloudWatch batch with the contracted names and units', async () => {
    const send = vi.fn(async (_command: { input: unknown }) => ({}));
    const publisher = new AwsCapacityMetricPublisher('prod', { send } as CloudWatchMetricClient);
    await publisher.publish(signal);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as { input: Record<string, unknown> };
    const input = command.input as {
      Namespace: string;
      MetricData: Array<{
        MetricName: string;
        Unit: string;
        StorageResolution: number;
        Dimensions: Array<{ Name: string; Value: string }>;
      }>;
    };
    expect(input.Namespace).toBe(CAPACITY_METRIC_NAMES.namespace);
    expect(input.MetricData.map((metric) => metric.MetricName)).toEqual([
      CAPACITY_METRIC_NAMES.required,
      CAPACITY_METRIC_NAMES.provisioned,
      CAPACITY_METRIC_NAMES.busy,
      CAPACITY_METRIC_NAMES.readyIdle,
      CAPACITY_METRIC_NAMES.eligible,
      CAPACITY_METRIC_NAMES.campaign,
      CAPACITY_METRIC_NAMES.oldestAge,
    ]);
    expect(input.MetricData.every((metric) => metric.StorageResolution === 1)).toBe(true);
    expect(input.MetricData.map((metric) => metric.Unit)).toEqual([
      'Count',
      'Count',
      'Count',
      'Count',
      'Count',
      'Count',
      'Seconds',
    ]);
    expect(input.MetricData[0]?.Dimensions).toEqual([
      { Name: 'Environment', Value: 'prod' },
      { Name: 'Service', Value: 'workers' },
    ]);
    expect(publisher.last()).toBe(signal);
  });

  it('keeps the last successful signal and emits a structured log', async () => {
    const log = vi.fn();
    const publisher = new LogCapacitySignalPublisher(log);
    await publisher.publish(signal);
    expect(log).toHaveBeenCalledWith({
      event: 'capacity_signal',
      ...signal,
      at: signal.at.toISOString(),
    });
    expect(publisher.last()).toBe(signal);
  });
});
