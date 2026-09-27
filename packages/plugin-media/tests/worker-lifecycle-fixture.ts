import { randomUUID } from 'node:crypto';

type Delivery<R> = { messageId: string; receiptHandle: string; reference: R; receiveCount: number };

export class FixtureQueue<R> {
  private pending: Delivery<R>[] = [];
  async send(reference: R) {
    const messageId = randomUUID();
    this.pending.push({ messageId, receiptHandle: messageId, reference, receiveCount: 1 });
    return { messageId };
  }
  async receive(options: { maxMessages?: number; waitSeconds?: number } = {}) {
    return this.pending.slice(0, options.maxMessages ?? 1);
  }
  async delete(delivery: Delivery<R>) {
    this.pending = this.pending.filter((row) => row.messageId !== delivery.messageId);
  }
  async changeVisibility() {}
}

export class SyntheticProtection {
  established = 0;
  released = 0;
  async establish() {
    this.established += 1;
    return true;
  }
  async renew() {
    return true;
  }
  async release() {
    this.released += 1;
  }
}
