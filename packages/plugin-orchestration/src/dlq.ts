import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';

export interface DeadLetterMessage {
  messageId: string;
  receiptHandle: string;
  body?: string;
}

export interface DeadLetterQueue {
  receive(): Promise<DeadLetterMessage[]>;
  delete(message: DeadLetterMessage): Promise<void>;
}

/** Raw receive is intentional: a malformed body must be counted and deleted individually. */
export class SqsDeadLetterQueue implements DeadLetterQueue {
  private readonly client: SQSClient;

  constructor(
    private readonly url: string,
    config: SQSClientConfig = {},
  ) {
    this.client = new SQSClient(config);
  }

  async receive(): Promise<DeadLetterMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 30,
      }),
    );
    return (response.Messages ?? []).map((message) => {
      if (!message.MessageId || !message.ReceiptHandle)
        throw new Error('DLQ message has no SQS identity');
      return {
        messageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        body: message.Body,
      };
    });
  }

  async delete(message: DeadLetterMessage): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.url,
        ReceiptHandle: message.receiptHandle,
      }),
    );
  }

  destroy(): void {
    this.client.destroy();
  }
}
