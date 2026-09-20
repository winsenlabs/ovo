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
  UpdateServiceCommand,
  UpdateTaskProtectionCommand,
  type ECSClientConfig,
} from '@aws-sdk/client-ecs';
import {
  CloudWatchClient,
  PutMetricDataCommand,
  type CloudWatchClientConfig,
} from '@aws-sdk/client-cloudwatch';
import type {
  DesiredCountWriter,
  CapacityWriteGuard,
  DurableQueue,
  JobReference,
  QueueDelivery,
  TaskProtection,
} from './types.ts';

export interface EcsServiceApi {
  update(input: { cluster: string; service: string; desiredCount: number }): Promise<void>;
  describe(input: {
    cluster: string;
    service: string;
  }): Promise<{ desiredCount: number; runningCount: number; pendingCount: number }>;
}

export class StaleCapacityAuthorityError extends Error {}
export class UnresolvedCapacityWriteError extends Error {}
export class UncertainCapacityWriteError extends Error {}

class AwsEcsServiceApi implements EcsServiceApi {
  private readonly client: ECSClient;

  constructor(config: ECSClientConfig) {
    this.client = new ECSClient(config);
  }

  async update(input: { cluster: string; service: string; desiredCount: number }): Promise<void> {
    await this.client.send(new UpdateServiceCommand(input));
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
    private readonly expiresInMinutes = 10,
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

/** The dispatcher is the only component constructed with this writer. Terraform ignores desiredCount drift. */
export class EcsDesiredCountWriter implements DesiredCountWriter {
  private readonly api: EcsServiceApi;

  constructor(
    readonly authorityId: string,
    private readonly cluster: string,
    private readonly serviceByKey: Readonly<Record<string, string>>,
    private readonly guard: CapacityWriteGuard,
    config: ECSClientConfig = {},
    api?: EcsServiceApi,
  ) {
    this.api = api ?? new AwsEcsServiceApi(config);
  }

  async write(serviceKey: string, desiredCount: number, epoch: number): Promise<void> {
    const service = this.serviceByKey[serviceKey];
    if (!service) throw new Error(`No ECS service mapping for ${serviceKey}`);
    if (!Number.isInteger(desiredCount) || desiredCount < 0)
      throw new Error('desiredCount must be a non-negative integer');
    const permit = await this.guard.begin({
      serviceKey,
      authorityId: this.authorityId,
      epoch,
      desiredCount,
    });
    if (permit.kind === 'stale_authority') {
      throw new StaleCapacityAuthorityError('Capacity authority or epoch is stale');
    }
    if (permit.kind === 'unresolved') {
      throw new UnresolvedCapacityWriteError(
        `Capacity write ${permit.attempt.attemptId} has an unresolved AWS outcome`,
      );
    }
    try {
      await this.api.update({ cluster: this.cluster, service, desiredCount });
    } catch (error) {
      await this.guard
        .markUnknown(
          permit.attempt.attemptId,
          error instanceof Error ? error.message : String(error),
        )
        .catch(() => false);
      throw new UncertainCapacityWriteError('ECS desired-count outcome is unknown');
    }
    try {
      if (!(await this.guard.markApplied(permit.attempt.attemptId))) {
        throw new Error('Capacity write intent was not current');
      }
    } catch {
      // AWS accepted the request but durable settlement failed. The inflight record blocks takeover writes.
      throw new UncertainCapacityWriteError(
        'ECS desired-count applied but durable settlement is unknown',
      );
    }
  }

  async read(
    serviceKey: string,
  ): Promise<{ desiredCount: number; runningCount: number; pendingCount: number }> {
    const service = this.serviceByKey[serviceKey];
    if (!service) throw new Error(`No ECS service mapping for ${serviceKey}`);
    return this.api.describe({ cluster: this.cluster, service });
  }

  async reconcile(serviceKey: string): Promise<boolean> {
    const pending = await this.guard.pending(serviceKey);
    if (!pending) return true;
    // Desired count is diagnostic only. It can match a preexisting value while a timed-out
    // UpdateService request is still able to arrive, so readback must never release this fence.
    await this.read(serviceKey).catch(() => undefined);
    return false;
  }
}

export class AwsCapacityMetricPublisher {
  private readonly client: CloudWatchClient;

  constructor(
    private readonly namespace = 'OVO/Capacity',
    config: CloudWatchClientConfig = {},
  ) {
    this.client = new CloudWatchClient(config);
  }

  async publish(serviceKey: string, values: Readonly<Record<string, number>>): Promise<void> {
    await this.client.send(
      new PutMetricDataCommand({
        Namespace: this.namespace,
        MetricData: Object.entries(values).map(([MetricName, Value]) => ({
          MetricName,
          Value,
          Unit: MetricName.endsWith('AgeMs') ? 'Milliseconds' : 'Count',
          Dimensions: [{ Name: 'Service', Value: serviceKey }],
        })),
      }),
    );
  }
}
