import { MULAW_8K, readSessionEvent } from '@winsendotai/ovo-contracts';
import { expect } from 'vitest';
import type { HumanQueueService } from '@winsendotai/ovo-plugin-operations';
import type { HumanQueueDefinition, QueueSnapshot } from '../src/human-contract.ts';
import type { CallMemory } from '../src/call-memory.ts';
import type { TransferController } from '../src/transfer-controller.ts';
import type { FakeClock } from './transfer-fixtures.ts';
import type { FakeMediaLink } from './segment-fixtures.ts';
import { FakeRooms } from './human-rooms.ts';
import { FakeHumanService } from './human-service.ts';
import { HumanShared } from '../src/human-breaker.ts';
import { HumanRuntime, type HumanRuntimeDeps } from '../src/human-runtime.ts';
import { createReturnToAgent } from '../src/human-return.ts';
import {
  agentRequest,
  holdPolicy,
  transferHarness,
  type HarnessOptions,
} from './transfer-fixtures.ts';

import { POOL } from './transfer-fixtures.ts';

/** The pool the harness's first agent segment is claimed from. */
export const POOL_FOR_TESTS = POOL;
export const QUEUE_ID = '33333333-3333-4333-8333-333333333333';
export const MANAGED_ID = '44444444-4444-4444-8444-444444444444';
export const OVERFLOW_ID = '55555555-5555-4555-8555-555555555555';

const context = {
  callerId: false,
  calledNumber: false,
  language: true,
  intent: true,
  summary: true,
  transcriptTurns: 0,
  transcriptLink: true,
  variables: [] as string[],
  summarize: 'agent_only' as const,
};

/** An external (third-party) queue snapshot, bound as `support-desk`. */
export function externalQueue(
  over: Record<string, unknown> = {},
  key = 'support-desk',
  id = QUEUE_ID,
): QueueSnapshot {
  const definition: HumanQueueDefinition = {
    kind: 'external',
    name: 'Acme ACD',
    limits: { maxWaiting: 100 },
    webhook: {
      url: 'https://acd.example.test/handoff',
      method: 'POST',
      format: 'json',
      credentialId: 'acd-hmac',
      auth: { kind: 'none' },
      headers: {},
      timeoutMs: 400,
      retry: { attempts: 3, baseMs: 500, maxMs: 5_000, deadlineMs: 15_000 },
      response: {
        acceptedValues: ['accepted', 'ok'],
        queuedValues: ['queued'],
        rejectedValues: ['rejected'],
      },
      cancel: true,
    },
    destination: {
      allowE164Prefixes: ['+9140'],
      allowSipHosts: ['.acd.example.com'],
      allowInsecureSip: false,
      allowedHeaders: ['X-Acd-Ticket'],
    },
    context: { ...context },
    callbackWindowHours: 24,
    ...over,
  } as HumanQueueDefinition;
  return { id, version: 1, key, priority: 1, definition };
}

/** A managed (OVO operator desk) queue snapshot, bound as `desk`. */
export function managedQueue(
  over: Record<string, unknown> = {},
  key = 'desk',
  id = MANAGED_ID,
): QueueSnapshot {
  const definition: HumanQueueDefinition = {
    kind: 'managed',
    name: 'Support desk',
    limits: { maxWaiting: 100 },
    assignment: 'OPEN_PICKUP',
    teamIds: [],
    language: 'prefer',
    offerSeconds: 20,
    joinSeconds: 25,
    requireOnline: true,
    ai: { mode: 'out', transcribeOperator: true },
    onOperatorLeave: 'end_call',
    returnTargets: ['billing'],
    wrapUp: { required: false, dispositions: [] },
    context: {
      ...context,
      callerId: true,
      calledNumber: true,
      transcriptTurns: 6,
      variables: 'declared',
    },
    ...over,
  } as HumanQueueDefinition;
  return { id, version: 1, key, priority: 0, definition };
}

/** What a human runtime in a transfer harness needs of the call around it. */
export interface HumanHarnessContext {
  clock: FakeClock;
  memory: CallMemory;
  link: FakeMediaLink;
  record(type: string, payload: Record<string, unknown>): void;
  audit(type: string, payload: Record<string, unknown>): void;
  log(event: string, fields: Record<string, unknown>): void;
  controller(): TransferController;
  hangUps: string[];
}

export interface HumanHarnessOptions extends Omit<HarnessOptions, 'human'> {
  queues?: QueueSnapshot[];
  webhookEnabled?: boolean;
  noRooms?: boolean;
  secrets?: Record<string, string>;
  network?: HumanRuntimeDeps['network'];
  carrierHandoff?: HumanRuntimeDeps['carrierHandoff'];
  numbers?: { from?: string; to?: string };
  /** The workspace the call is in and the store is scoped to (a shared database: one per test). */
  workspaceId?: string;
  /** A real store for the tickets (PostgreSQL); default core's in-memory service. */
  store?: (workspaceId: string, now: () => Date) => HumanQueueService;
  /** One registry shared by several calls, as the process shares it. */
  shared?: HumanShared;
  stt?: HumanRuntimeDeps['openStt'];
  transcript?: HumanRuntimeDeps['transcript'];
  summarize?: HumanRuntimeDeps['summarize'];
}

/** Session events the worker recorded that the contracts' `readSessionEvent` refused. */
const invalid: string[] = [];

/** Run after every test: each recorded event is storable (ids, codes and timings only, bounded). */
export function assertEventsValid(): void {
  expect(invalid.splice(0)).toEqual([]);
}

/** A transfer harness whose call has human queues, a fake ticket store and a fake room. */
export function humanHarness(options: HumanHarnessOptions = {}) {
  let clockNow = () => 0;
  const now = () => new Date(clockNow());
  const workspaceId = options.workspaceId ?? 'ws-1';
  const service = new FakeHumanService(now, workspaceId, options.store?.(workspaceId, now));
  const rooms = new FakeRooms();
  const shared = options.shared ?? new HumanShared();
  const ended: string[] = [];
  const handedOff: string[] = [];
  let runtime!: HumanRuntime;
  const base = transferHarness({
    ...options,
    onRecord: (type, payload) => {
      try {
        readSessionEvent(type, payload);
      } catch (error) {
        invalid.push(`${type}: ${String(error).slice(0, 300)}`);
      }
    },
    human: (ctx) => {
      clockNow = ctx.clock.now;
      runtime = new HumanRuntime({
        queues: new Map(
          (options.queues ?? [externalQueue(), managedQueue()]).map((q) => [q.key, q]),
        ),
        service,
        ...(options.noRooms ? {} : { rooms }),
        shared,
        webhookEnabled: options.webhookEnabled ?? true,
        clock: ctx.clock,
        ended: () => ctx.controller().endedSignal,
        call: {
          workspaceId,
          jobId: 'job-1',
          sessionId: 'session-1',
          callId: 'call-1',
          routingReleaseId: '00000000-0000-4000-8000-0000000000f1',
          routerAgentId: 'front',
          direction: 'inbound',
          startedAt: 1_700_000_000_000,
          numbers: options.numbers ?? { from: '+919800001234', to: '+918000000002' },
        },
        format: MULAW_8K,
        ...(options.policy ? { policy: options.policy } : {}),
        memory: ctx.memory,
        secrets: {
          resolve: async (_workspace: string, id: string) => {
            const found =
              options.secrets?.[id] ?? (id.startsWith('acd') ? 'acd-secret' : undefined);
            if (!found) throw new Error('credential not allowed');
            return found;
          },
        },
        callbackBaseUrl: 'https://ovo.example.test',
        pollMs: 100,
        contextRetentionHours: 24,
        ...(options.network ? { network: options.network } : {}),
        random: () => 0.5,
        record: ctx.record,
        audit: ctx.audit,
        log: ctx.log,
        ...(options.carrierHandoff ? { carrierHandoff: options.carrierHandoff } : {}),
        endHandedOff: async () => {
          handedOff.push('transferred');
          await ctx.link.close('transferred');
        },
        endCall: async (lease, reason) => {
          ended.push(reason);
          if (ctx.controller().mayEndCall(lease)) ctx.hangUps.push(reason);
          await lease.close(reason);
        },
        declaredValues: async () => ({ account_id: 'A-1', secret_note: { nested: true } }),
        ...(options.summarize ? { summarize: options.summarize } : {}),
        ...(options.stt ? { openStt: options.stt } : {}),
        ...(options.transcript ? { transcript: options.transcript } : {}),
        sttLanguage: 'en-IN',
        usageFor: () => () => undefined,
        attachedEntry: () => ctx.controller().attached,
        returnToAgent: (input) =>
          createReturnToAgent({
            controller: ctx.controller(),
            ...(options.policy ? { policy: options.policy } : {}),
            resolve: async (target) => {
              const destination = target.destination as {
                agent?: { release?: { releaseId?: string } };
              };
              const releaseId = destination.agent?.release?.releaseId ?? 'release-a';
              return { request: agentRequest(releaseId), target, claimed: false };
            },
            holdPlayer: (tags) => ctx.controller().deps.holdPlayer(holdPolicy(), tags),
            releaseClaim: async () => undefined,
          })(input),
      });
      return runtime;
    },
  });
  return { ...base, service, rooms, shared, ended, handedOff, runtime: () => runtime };
}

export type HumanHarness = ReturnType<typeof humanHarness>;

export * from './human-rooms.ts';
export * from './human-service.ts';
export * from './human-stt-fixture.ts';
