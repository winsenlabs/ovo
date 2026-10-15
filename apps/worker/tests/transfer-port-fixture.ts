import {
  type HandoffBeginResult,
  type MemberClaim,
  type PoolSnapshot,
  type SegmentHandoffRequest,
  type TransferTarget,
} from '@winsendotai/ovo-contracts';
import { vi } from 'vitest';
import { CallMemory } from '../src/call-memory.ts';
import type { TransferController } from '../src/transfer-controller.ts';
import { createAgentTransferPort } from '../src/transfer-port.ts';
import { CLAIM, POOL, transferPolicy } from './transfer-fixtures.ts';

export const OTHER_POOL = '33333333-3333-4333-8333-333333333333';
const member = (
  id: string,
  releaseId: string,
  extra: Partial<PoolSnapshot['members'][number]> = {},
) => ({
  id,
  agent: { agentId: `agent-${id}`, release: { kind: 'pinned' as const, releaseId } },
  languages: ['en'],
  products: [],
  skills: [],
  priority: 50,
  enabled: true,
  ...extra,
});
const pools: Record<string, PoolSnapshot> = {
  [POOL]: {
    id: POOL,
    version: 1,
    name: 'Sales',
    languageFallback: [],
    members: [member('a', 'release-a'), member('a2', 'release-a2', { skills: ['senior'] })],
  },
  [OTHER_POOL]: {
    id: OTHER_POOL,
    version: 1,
    name: 'Billing',
    languageFallback: [],
    members: [member('b', 'release-b'), member('b2', 'release-b2', { priority: 10 })],
  },
};
export const targets: TransferTarget[] = [
  {
    key: 'billing',
    description: 'Payments and refunds',
    label: { en: 'our billing team', hi: 'बिलिंग टीम' },
    destination: { kind: 'pool', poolId: OTHER_POOL, language: 'caller', skills: [] },
    from: [{ kind: 'pool', poolId: POOL }],
  },
  {
    key: 'senior',
    description: 'A senior colleague',
    confirm: 'ask',
    destination: { kind: 'same-pool', language: 'caller', skills: ['senior'] },
  },
  {
    key: 'desk',
    description: 'The front desk',
    destination: {
      kind: 'agent',
      agent: { agentId: 'agent-c', release: { kind: 'pinned', releaseId: 'release-c' } },
    },
    from: [{ kind: 'agent', agentId: 'agent-x' }],
    announcement: { en: 'One moment, the desk will help.' },
  },
  {
    key: 'myself',
    description: 'Myself',
    destination: {
      kind: 'agent',
      agent: { agentId: 'agent-a', release: { kind: 'pinned', releaseId: 'release-a' } },
    },
  },
  {
    key: 'language',
    description: 'Another language',
    destination: { kind: 'node', node: 'language' },
  },
];

/** One agent segment's port on a fake controller, claims and memory. */
export function port(
  options: {
    policy?: ReturnType<typeof transferPolicy> | 'none';
    claim?: MemberClaim | 'throws';
    begin?: HandoffBeginResult;
    transfers?: number;
    segments?: number;
    remainingSeconds?: number;
    language?: string;
    line?: string;
  } = {},
) {
  const memory = new CallMemory();
  memory.route = { path: ['intent'], language: 'en', context: { intent: 'sales' } };
  memory.started({
    index: 0,
    role: 'router',
    agentId: 'front',
    releaseId: 'release-router',
    startedAt: 0,
  });
  memory.started({
    index: 1,
    role: 'agent',
    agentId: 'agent-b',
    releaseId: 'release-b',
    poolId: OTHER_POOL,
    memberId: 'b',
    startedAt: 1,
  });
  memory.started({
    index: 2,
    role: 'agent',
    agentId: 'agent-a',
    releaseId: 'release-a',
    poolId: POOL,
    memberId: 'a',
    startedAt: 2,
  });
  const begun: SegmentHandoffRequest[] = [];
  const controller = {
    transfers: options.transfers ?? 1,
    segments: options.segments ?? 3,
    busy: false,
    ended: false,
    attached: { index: 2 },
    deps: { callEndsAt: 1_000_000 + (options.remainingSeconds ?? 600) * 1000 },
    clock: { now: () => 1_000_000 },
    beginWith: vi.fn(async (request: SegmentHandoffRequest) => {
      begun.push(request);
      return options.begin ?? { ok: true, handoffId: 'handoff-1', state: 'preparing' };
    }),
    commit: vi.fn(),
    uncommitted: vi.fn((id: string) =>
      id === 'handoff-1' ? { transfer: 2, hold: { source: 'point' } } : undefined,
    ),
    abandon: vi.fn(async () => undefined),
    handover: vi.fn(() => ({ kind: 'transfer', transcript: [], captured: {}, disclosed: [] })),
  };
  const claims = {
    claim: vi.fn(async (tiers: readonly (readonly { releaseId: string }[])[]) => {
      if (options.claim === 'throws') throw new Error('down');
      return (
        options.claim ??
        ({ kind: 'claimed', claimId: CLAIM, candidate: tiers[0]![0] } as MemberClaim)
      );
    }),
    release: vi.fn(async () => undefined),
  };
  const recorded: [string, Record<string, unknown>][] = [];
  const logs: [string, Record<string, unknown>][] = [];
  const policy =
    options.policy === 'none' ? undefined : (options.policy ?? transferPolicy({ targets }));
  const created = createAgentTransferPort({
    controller: controller as unknown as TransferController,
    self: { index: 2, agentId: 'agent-a', releaseId: 'release-a', poolId: POOL, memberId: 'a' },
    release: {
      config: {
        language: options.language ?? 'en',
        variables: {},
        ...(options.line ? { handoff: { agents: { line: options.line } } } : {}),
      } as never,
    },
    ...(policy ? { policy } : {}),
    targets: {
      snapshot: { pools, language: { default: 'en', allowed: ['en', 'hi'] } },
      memory,
      claims,
      now: () => Date.now(),
    },
    record: (type, payload) => recorded.push([type, payload]),
    log: (event, fields) => logs.push([event, fields]),
  });
  return { port: created, controller, claims, recorded, logs, begun, memory };
}

export const ask = (key: string, confirmed = false) => ({
  key,
  source: 'llm' as const,
  confirmed,
  summary: 'Double charge',
  reason: 'refund',
});
export const signal = () => new AbortController().signal;
