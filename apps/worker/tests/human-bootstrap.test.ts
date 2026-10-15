import { OPERATIONS_SERVICE_KEY } from '@winsendotai/ovo-plugin-operations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { humanQueueWorkerOptions } from '../src/worker-environment.ts';
import { createProductionWorkerMediaRuntime } from '../src/worker-media-bootstrap.ts';
import { terminateOwnedJob } from '../src/worker-termination.ts';

function routing(operations: unknown, extra: Record<string, unknown> = {}) {
  const graph = {
    parent: {
      ctx: {
        get: (key: string) => {
          if (key === OPERATIONS_SERVICE_KEY) return operations;
          throw new Error(`missing ${key}`);
        },
      },
    },
  };
  const media = createProductionWorkerMediaRuntime({
    ...{ httpServer: {} as never, gatewayUrl: 'ws://127.0.0.1:1/worker', gatewayToken: 'test' },
    ...{
      workerId: 'worker-1',
      onDisconnect: vi.fn(),
      store: {} as never,
      controlStore: {} as never,
    },
    ...{
      secrets: {} as never,
      telemetry: {} as never,
      extensions: { plugins: [], nativeHandlers: {} },
    },
    costs: { usageForJob: () => undefined, inferenceUsageForJob: () => undefined } as never,
    ...{ recordings: {} as never, recordingRetentionDays: 30, speechCache: {} as never },
    telephony: {} as never,
    graph: graph as never,
    ...extra,
  });
  const factory = (media as unknown as { factory: { factory: unknown } }).factory.factory;
  return (factory as { routing: Record<string, unknown> }).routing;
}

const service = { enabled: true, tickets: {}, operators: {} };
const operations = { routing: { releases: {}, claims: {} }, humanQueues: service };

describe('the human queue environment (Wave 17)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is off by default, with a 400 ms poll, 24 hour context retention and the media origin', () => {
    for (const name of [
      'OVO_HUMAN_QUEUE_ENABLED',
      'OVO_HUMAN_QUEUE_WEBHOOK_ENABLED',
      'OVO_HUMAN_QUEUE_CALLBACK_BASE_URL',
      'OVO_HUMAN_QUEUE_POLL_MS',
      'OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS',
    ])
      vi.stubEnv(name, undefined);
    vi.stubEnv('OVO_MEDIA_PUBLIC_BASE_URL', 'https://voice.example.test/');
    expect(humanQueueWorkerOptions()).toEqual({
      enabled: false,
      webhookEnabled: false,
      callbackBaseUrl: 'https://voice.example.test',
      pollMs: 400,
      contextRetentionHours: 24,
    });
  });

  it('switches on only for the exact value true, and the callback origin overrides the media one', () => {
    vi.stubEnv('OVO_HUMAN_QUEUE_ENABLED', 'TRUE');
    vi.stubEnv('OVO_HUMAN_QUEUE_WEBHOOK_ENABLED', 'yes');
    expect(humanQueueWorkerOptions()).toMatchObject({ enabled: false, webhookEnabled: false });
    vi.stubEnv('OVO_HUMAN_QUEUE_ENABLED', 'true');
    vi.stubEnv('OVO_HUMAN_QUEUE_WEBHOOK_ENABLED', 'true');
    vi.stubEnv('OVO_HUMAN_QUEUE_CALLBACK_BASE_URL', 'https://hooks.example.test');
    expect(humanQueueWorkerOptions()).toMatchObject({
      enabled: true,
      webhookEnabled: true,
      callbackBaseUrl: 'https://hooks.example.test',
    });
  });

  it('reads the poll within 100-2000 ms and the retention within 0-720 hours, refusing the rest', () => {
    vi.stubEnv('OVO_HUMAN_QUEUE_POLL_MS', '250');
    vi.stubEnv('OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS', '0');
    expect(humanQueueWorkerOptions()).toMatchObject({ pollMs: 250, contextRetentionHours: 0 });
    for (const [name, value] of [
      ['OVO_HUMAN_QUEUE_POLL_MS', '99'],
      ['OVO_HUMAN_QUEUE_POLL_MS', '2001'],
      ['OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS', '721'],
    ] as const)
      expect(() => {
        vi.unstubAllEnvs();
        vi.stubEnv(name, value);
        humanQueueWorkerOptions();
      }).toThrow(`${name} must be an integer between`);
  });
});

describe('the worker composes human queues only when everything asked for them (flags off: R2)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('has no human queue options by default, or with only the master flag, or without transfers', () => {
    expect(routing(operations)).not.toHaveProperty('humanQueue');
    vi.stubEnv('OVO_HUMAN_QUEUE_ENABLED', 'true');
    expect(routing(operations)).not.toHaveProperty('humanQueue');
    vi.stubEnv('OVO_ROUTING_TRANSFER_ENABLED', 'true');
    expect(routing({ routing: operations.routing })).not.toHaveProperty('humanQueue');
  });

  it('composes them with the master flag, transfers and the operations ticket store', () => {
    vi.stubEnv('OVO_HUMAN_QUEUE_ENABLED', 'true');
    vi.stubEnv('OVO_ROUTING_TRANSFER_ENABLED', 'true');
    vi.stubEnv('OVO_HUMAN_QUEUE_WEBHOOK_ENABLED', 'true');
    const composed = routing(operations) as { humanQueue: Record<string, unknown> };
    expect(composed.humanQueue).toMatchObject({
      enabled: true,
      webhookEnabled: true,
      service,
      pollMs: 400,
    });
    expect(composed.humanQueue.transferTargets).toBeInstanceOf(Map);
    expect(composed.humanQueue).not.toHaveProperty('rooms');
    const rooms = { provider: 'fake' } as never;
    expect(routing(operations, { rooms })).toMatchObject({ humanQueue: { rooms } });
  });
});

describe('a session a human queue handed on ends without a second handoff or a hang-up', () => {
  it('passes handedOff through the owned termination to the carrier leg', async () => {
    const calls: string[] = [];
    await terminateOwnedJob({
      jobId: 'job-1',
      workerId: 'worker-1',
      ownerEpoch: 2,
      reason: 'transferred',
      transfer: { handedOff: true },
      store: {
        get: async () => ({ id: 'job-1', workspaceId: 'ws-1', payload: {} }),
        getSessionRoute: async () => ({ sessionId: 's-1', jobId: 'job-1', carrierCallId: 'CA1' }),
        requestSessionTermination: async () => {
          calls.push('fence');
          return { carrierCallId: 'CA1' };
        },
      } as never,
      carriers: {
        forJob: async () => ({
          control: {
            hangup: async () => void calls.push('hangup'),
            handoff: async () => void calls.push('handoff'),
          },
          carrier: { capabilities: { control: { hangup: 'rest', handoff: ['phone'] } } },
        }),
      } as never,
      media: {
        terminate: async () => void calls.push('terminate'),
        closeSession: async () => void calls.push('close'),
      } as never,
    });
    expect(calls).toEqual(['fence', 'close']);
  });
});
