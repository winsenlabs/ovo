import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import {
  ECSClient,
  DescribeServicesCommand,
  UpdateTaskProtectionCommand,
  type ECSClientConfig,
} from '@aws-sdk/client-ecs';
import {
  CloudWatchClient,
  PutMetricDataCommand,
  type CloudWatchClientConfig,
} from '@aws-sdk/client-cloudwatch';
import { CAPACITY_METRIC_NAMES, type CapacitySignal, type CapacitySignalPublisher } from '@winsendotai/ovo-contracts';
import type {
  DurableQueue,
  JobReference,
  QueueDelivery,
  TaskProtection,
} from './types.ts';

export interface EcsServiceApi {
  describe(input: {
    cluster: string;
    service: string;
  }): Promise<{ desiredCount: number; runningCount: number; pendingCount: number }>;
}

class AwsEcsServiceApi implements EcsServiceApi {
  private readonly client: ECSClient;

  constructor(config: ECSClientConfig) {
    this.client = new ECSClient(config);
  }

  async describe(input: {
    cluster: string;
    service: string;
  }): Promise<{ desiredCount: number; runningCount: number; pendingCount: number }> {
    const result = await this.client.send(
      new DescribeServicesCommand({ cluster: input.cluster, services: [input.service] }),
    );
    if (result.failures?.length || !result.services?.[0]) {
      throw new Error(`Unable to describe ECS service ${input.service}`);
    }
    return {
      desiredCount: result.services[0].desiredCount ?? 0,
      runningCount: result.services[0].runningCount ?? 0,
      pendingCount: result.services[0].pendingCount ?? 0,
    };
  }
}

function parseReference(body: string | undefined): JobReference {
  if (!body) throw new Error('SQS job message has no body');
  const value: unknown = JSON.parse(body);
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new Error('Unsupported SQS job reference schema');
  }
  const jobId = (value as { jobId?: unknown }).jobId;
  if (typeof jobId !== 'string' || !jobId) throw new Error('SQS job reference has no jobId');
  return { schemaVersion: 1, jobId };
}

export class SqsDurableQueue implements DurableQueue {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    config: SQSClientConfig = {},
  ) {
    this.client = new SQSClient(config);
  }

  async send(reference: JobReference): Promise<{ messageId: string }> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(reference),
      }),
    );
    if (!result.MessageId) throw new Error('SQS did not return a message ID');
    return { messageId: result.MessageId };
  }

  async receive(
    options: { maxMessages?: number; waitSeconds?: number; visibilitySeconds?: number } = {},
  ): Promise<QueueDelivery[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: Math.min(10, Math.max(1, options.maxMessages ?? 1)),
        WaitTimeSeconds: Math.min(20, Math.max(0, options.waitSeconds ?? 20)),
        VisibilityTimeout: Math.min(43_200, Math.max(0, options.visibilitySeconds ?? 60)),
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return (result.Messages ?? []).map((message) => {
      if (!message.MessageId || !message.ReceiptHandle)
        throw new Error('SQS delivery is missing identity');
      return {
        messageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        reference: parseReference(message.Body),
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      };
    });
  }

  async delete(delivery: QueueDelivery): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: delivery.receiptHandle }),
    );
  }

  async changeVisibility(delivery: QueueDelivery, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: delivery.receiptHandle,
        VisibilityTimeout: Math.min(43_200, Math.max(0, Math.floor(seconds))),
      }),
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}

export class EcsTaskProtection implements TaskProtection {
  private readonly client: ECSClient;

  constructor(
    private readonly cluster: string,
    private readonly taskArn: string,
    private readonly expiresInMinutes = 60,
    config: ECSClientConfig = {},
  ) {
    this.client = new ECSClient(config);
  }

  async establish(): Promise<boolean> {
    return this.set(true);
  }

  async renew(): Promise<boolean> {
    return this.set(true);
  }

  async release(): Promise<void> {
    await this.set(false);
  }

  private async set(protectionEnabled: boolean): Promise<boolean> {
    try {
      const result = await this.client.send(
        new UpdateTaskProtectionCommand({
          cluster: this.cluster,
          tasks: [this.taskArn],
          protectionEnabled,
          expiresInMinutes: protectionEnabled ? this.expiresInMinutes : undefined,
        }),
      );
      return !result.failures?.length && result.protectedTasks?.length === 1;
    } catch {
      return false;
    }
  }
}

/** ECS is diagnostic input only; Application Auto Scaling owns DesiredCount. */
export class EcsServiceReader {
  private readonly api: EcsServiceApi;

  constructor(
    private readonly cluster: string,
    private readonly serviceByKey: Readonly<Record<string, string>>,
    config: ECSClientConfig = {},
    api?: EcsServiceApi,
  ) {
    this.api = api ?? new AwsEcsServiceApi(config);
  }

  async read(
    serviceKey: string,
  ): Promise<{ desiredCount: number; runningCount: number; pendingCount: number }> {
    const service = this.serviceByKey[serviceKey];
    if (!service) throw new Error(`No ECS service mapping for ${serviceKey}`);
    return this.api.describe({ cluster: this.cluster, service });
  }
}

export interface CloudWatchMetricClient {
  send(command: PutMetricDataCommand): Promise<unknown>;
}

/** One high-resolution metric batch per tick. The client is injected for deterministic tests. */
export class AwsCapacityMetricPublisher implements CapacitySignalPublisher {
  private readonly client: CloudWatchMetricClient;
  private previous?: CapacitySignal;

  constructor(
    private readonly environment: string,
    client?: CloudWatchMetricClient,
    config: CloudWatchClientConfig = {},
  ) {
    this.client = client ?? new CloudWatchClient(config);
  }

  async publish(signal: CapacitySignal): Promise<void> {
    const names = CAPACITY_METRIC_NAMES;
    const values = [
      [names.required, signal.requiredSlots],
      [names.provisioned, signal.provisionedTasks],
      [names.busy, signal.busySlots],
      [names.readyIdle, signal.readyIdleSlots],
      [names.eligible, signal.eligibleJobs],
      [names.campaign, signal.campaignDemand],
      [names.oldestAge, signal.oldestEligibleJobAgeSeconds],
    ] as const;
    await this.client.send(new PutMetricDataCommand({
      Namespace: names.namespace,
      MetricData: values.map(([MetricName, Value]) => ({
        MetricName,
        Value,
        Unit: MetricName === names.oldestAge ? 'Seconds' : 'Count',
        StorageResolution: 1,
        Timestamp: signal.at,
        Dimensions: [
          { Name: 'Environment', Value: this.environment },
          { Name: 'Service', Value: 'workers' },
        ],
      })),
    }));
    this.previous = signal;
  }

  last(): CapacitySignal | undefined {
    return this.previous;
  }
}
