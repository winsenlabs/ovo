import { describe, expect, it, vi } from 'vitest';
import { DlqReconcilerTask, JobHintSweeperTask } from '../src/background-tasks.ts';
import type { DeadLetterMessage, DeadLetterQueue } from '../src/dlq.ts';

const id = '00000000-0000-4000-8000-000000000001';

function fixture() {
  const sweep = vi.fn(async () => ({ hinted: 1, poisoned: [id] }));
  const resetHint = vi.fn(async (_id: string) => undefined);
  return { hints: { sweep, resetHint } };
}

describe('dispatcher orchestration background tasks', () => {
  it('sweeps a bounded batch and emits an alarmable poison event', async () => {
    const store = fixture();
    const log = vi.fn();
    const task = new JobHintSweeperTask(store, log);
    await task.tick(new AbortController().signal);
    expect(store.hints.sweep).toHaveBeenCalledWith(100);
    expect(log).toHaveBeenCalledWith({ event: 'hint_exhausted', jobId: id });
  });

  it('resets a valid DLQ hint, deletes malformed messages and never sends blind redrives', async () => {
    const store = fixture();
    const messages: DeadLetterMessage[] = [
      { messageId: 'valid', receiptHandle: 'a', body: JSON.stringify({ schemaVersion: 1, jobId: id }) },
      { messageId: 'malformed', receiptHandle: 'b', body: '{broken' },
      { messageId: 'bad-id', receiptHandle: 'c', body: JSON.stringify({ schemaVersion: 1, jobId: 'not-a-uuid' }) },
    ];
    const queue: DeadLetterQueue = { receive: vi.fn(async () => messages), delete: vi.fn(async () => undefined) };
    const log = vi.fn();
    const task = new DlqReconcilerTask(store, queue, log);
    await task.tick(new AbortController().signal);
    expect(store.hints.resetHint).toHaveBeenCalledExactlyOnceWith(id);
    expect(queue.delete).toHaveBeenCalledTimes(3);
    expect(task.malformed).toBe(2);
    expect(log).toHaveBeenCalledWith({ event: 'dlq_malformed', messageId: 'malformed' });
    expect('send' in queue).toBe(false);
  });

  it('keeps a DLQ message when resetting the durable hint fails', async () => {
    const store = fixture();
    store.hints.resetHint.mockRejectedValue(new Error('database unavailable'));
    const queue: DeadLetterQueue = {
      receive: async () => [{ messageId: 'valid', receiptHandle: 'a', body: JSON.stringify({ schemaVersion: 1, jobId: id }) }],
      delete: vi.fn(async () => undefined),
    };
    const task = new DlqReconcilerTask(store, queue);
    await expect(task.tick(new AbortController().signal)).rejects.toThrow('database unavailable');
    expect(queue.delete).not.toHaveBeenCalled();
  });
});
