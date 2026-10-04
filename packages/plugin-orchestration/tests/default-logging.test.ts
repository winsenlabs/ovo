import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { DlqReconcilerTask, JobHintSweeperTask } from '../src/background-tasks.ts';
import { LogCapacitySignalPublisher } from '../src/capacity-signals.ts';
import { ProtectionRenewal } from '../src/services.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function captureDefaultConsole() {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      done();
    },
  });
  vi.stubGlobal('console', new Console({ stdout: stream, stderr: stream }));
  return () => JSON.parse(output.trim()) as Record<string, unknown>;
}

it('writes a JSON hint_exhausted event through its default console sink', async () => {
  const entry = captureDefaultConsole();
  const task = new JobHintSweeperTask({
    hints: {
      sweep: async () => ({ hinted: 0, poisoned: ['job-1'] }),
      resetHint: async () => undefined,
    },
  });
  await task.tick(new AbortController().signal);
  expect(entry()).toEqual({ event: 'hint_exhausted', jobId: 'job-1' });
});

it('writes a JSON protection_renewal_failed event through its default console sink', async () => {
  vi.useFakeTimers();
  const entry = captureDefaultConsole();
  const renewal = new ProtectionRenewal(
    {
      establish: async () => true,
      renew: async () => false,
      release: async () => undefined,
    },
    10,
    () => undefined,
  );
  try {
    expect(await renewal.establish()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(entry()).toEqual({ event: 'protection_renewal_failed', remainingMs: 3_599_990 });
  } finally {
    await renewal.release();
  }
});

it('writes a JSON dlq_malformed event through its default console sink', async () => {
  const entry = captureDefaultConsole();
  const task = new DlqReconcilerTask(
    {
      hints: {
        sweep: async () => ({ hinted: 0, poisoned: [] }),
        resetHint: async () => undefined,
      },
    },
    {
      receive: async () => [{ messageId: 'message-1', receiptHandle: 'receipt', body: '{' }],
      delete: async () => undefined,
    },
  );
  await task.tick(new AbortController().signal);
  expect(entry()).toEqual({ event: 'dlq_malformed', messageId: 'message-1' });
});

it('writes a JSON capacity_signal event through its default console sink', async () => {
  const entry = captureDefaultConsole();
  const signal = {
    requiredSlots: 2,
    provisionedTasks: 2,
    busySlots: 1,
    readyIdleSlots: 1,
    eligibleJobs: 0,
    campaignDemand: 0,
    oldestEligibleJobAgeSeconds: 0,
    at: new Date('2026-09-26T00:00:00Z'),
  };
  const publisher = new LogCapacitySignalPublisher();
  await publisher.publish(signal);
  expect(entry()).toEqual({ event: 'capacity_signal', ...signal, at: signal.at.toISOString() });
});
