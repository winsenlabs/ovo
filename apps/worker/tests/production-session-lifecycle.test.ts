import { describe, expect, it } from 'vitest';
import { SessionCleanupStack } from '../src/session-lifecycle.ts';

const RESOURCES = ['telemetry', 'recording', 'composition', 'engine'] as const;

describe('production session cleanup', () => {
  it.each(['binding conversion', 'catalog creation', 'release validation'])(
    'closes recording then telemetry when %s throws before compose',
    async (step) => {
      const stack = new SessionCleanupStack();
      const calls: string[] = [];
      const setupFailure = new Error(`${step} failed`);
      stack.defer(() => {
        calls.push('telemetry');
      });
      stack.defer(() => {
        calls.push('recording');
      });

      await expect(stack.close(setupFailure)).resolves.toBe(setupFailure);
      expect(calls).toEqual(['recording', 'telemetry']);
    },
  );

  it.each(RESOURCES)('continues reverse cleanup when %s cleanup fails', async (failing) => {
    const stack = new SessionCleanupStack();
    const calls: string[] = [];
    const failure = new Error(`${failing} failed`);
    for (const resource of RESOURCES) {
      stack.defer(() => {
        calls.push(resource);
        if (resource === failing) throw failure;
      });
    }

    await expect(stack.close()).resolves.toBe(failure);
    expect(calls).toEqual([...RESOURCES].reverse());
  });

  it.each(RESOURCES)('preserves the setup failure while %s cleanup also fails', async (failing) => {
    const stack = new SessionCleanupStack();
    const calls: string[] = [];
    const setupFailure = new Error('catalog validation failed');
    for (const resource of RESOURCES) {
      stack.defer(() => {
        calls.push(resource);
        if (resource === failing) throw new Error(`${failing} cleanup failed`);
      });
    }

    await expect(stack.close(setupFailure)).resolves.toBe(setupFailure);
    expect(calls).toEqual([...RESOURCES].reverse());
  });

  it('passes the first disposal failure to later cleanup and closes only once', async () => {
    const stack = new SessionCleanupStack();
    const engineFailure = new Error('engine dispose failed');
    const observations: unknown[] = [];
    stack.defer((failure) => {
      observations.push(failure);
    });
    stack.defer(() => {
      throw engineFailure;
    });

    const first = stack.close();
    const second = stack.close(new Error('ignored later failure'));
    await expect(first).resolves.toBe(engineFailure);
    await expect(second).resolves.toBe(engineFailure);
    expect(observations).toEqual([engineFailure]);
  });
});
