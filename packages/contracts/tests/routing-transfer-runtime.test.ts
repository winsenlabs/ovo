import { describe, expect, it } from 'vitest';
import {
  AGENT_TRANSFER_REFUSALS,
  Cap,
  CAPABILITY_SPECS,
  DisclosurePayload,
  readSessionEvent,
  RouteFallbackPayload,
  RouterEntry,
  RouteSegmentPayload,
  SegmentEndedPayload,
  SegmentHandoffRequest,
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_TYPES,
  TransferCompletedPayload,
  TransferRequestedPayload,
  type AgentTransferPort,
  type CapabilityMap,
  type HandoffBeginResult,
  type SegmentHandoffPort,
} from '../src/index.ts';
import { POOL_SALES, SALES_EN_RELEASE, SALES_HI_RELEASE } from './routing-fixture.ts';

const agent = {
  kind: 'agent',
  reason: 'route',
  agentId: 'sales-hi',
  releaseId: SALES_HI_RELEASE,
};
const candidate = {
  poolId: POOL_SALES,
  memberId: 'sales-en',
  agentId: 'sales-en',
  releaseId: SALES_EN_RELEASE,
};

describe('segment handoff requests (R2 union)', () => {
  it('still parses the R1 agent request unchanged', () => {
    expect(SegmentHandoffRequest.parse(agent)).toEqual({ ...agent, variables: {} });
  });

  it('parses agent transfers, queues and re-routes', () => {
    const transfer = {
      key: 'billing',
      source: 'llm',
      reason: 'double charge',
      summary: 'Needs a refund.',
    };
    expect(SegmentHandoffRequest.parse({ ...agent, reason: 'transfer', transfer }).kind).toBe(
      'agent',
    );
    const queue = SegmentHandoffRequest.parse({
      kind: 'queue',
      reason: 'route',
      poolId: POOL_SALES,
      tiers: [[candidate, { ...candidate, memberId: 'sales-en-2', capacity: 2 }]],
    });
    expect(queue).toMatchObject({ kind: 'queue', variables: {} });
    const node = SegmentHandoffRequest.parse({
      kind: 'node',
      reason: 'transfer',
      node: 'language',
      transfer: { key: 'another_language', source: 'llm' },
    });
    expect(node).toMatchObject({ kind: 'node', node: 'language', variables: {} });
  });

  it('refuses malformed requests', () => {
    const queue = { kind: 'queue', reason: 'route', poolId: POOL_SALES, tiers: [[candidate]] };
    const node = {
      kind: 'node',
      reason: 'transfer',
      node: 'language',
      transfer: { source: 'llm' },
    };
    for (const bad of [
      { ...agent, reason: 'reroute' },
      { ...agent, kind: 'human' },
      { ...agent, transfer: { source: 'caller' } },
      { ...agent, transfer: { source: 'llm', summary: 'x'.repeat(1_001) } },
      { ...agent, transfer: { source: 'llm', reason: 'x'.repeat(201) } },
      { ...queue, tiers: [] },
      { ...queue, tiers: [[]] },
      { ...queue, tiers: [[{ ...candidate, extra: 1 }]] },
      { ...queue, tiers: [[{ ...candidate, capacity: 0 }]] },
      { ...node, reason: 'route' },
      { ...node, transfer: undefined },
      { ...node, variables: { account: '1' } },
    ])
      expect(SegmentHandoffRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('keeps begin optional on the port and its result typed', () => {
    const r1: SegmentHandoffPort = {
      prepare: async () => ({ ok: false, reason: 'unsupported' }),
      commit: () => {},
      abandon: async () => {},
    };
    expect(r1.begin).toBeUndefined();
    const queued: HandoffBeginResult = { ok: true, handoffId: 'h', state: 'queued' };
    const full: HandoffBeginResult = { ok: false, reason: 'pool_full' };
    expect([queued.ok, full.ok]).toEqual([true, false]);
  });

  it('validates router entries', () => {
    const entry = {
      node: 'language',
      path: ['intent'],
      context: { values: { intent: 'sales' } },
      transfer: 1,
    };
    expect(RouterEntry.parse(entry).disclosed).toEqual([]);
    for (const bad of [
      { ...entry, transfer: 0 },
      { ...entry, transfer: 11 },
      { ...entry, disclosed: ['legal'] },
      { ...entry, context: { language: 'english', values: {} } },
      { ...entry, node: 'Language' },
    ])
      expect(RouterEntry.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('registers ovo.agent-transfer as a one-per-session key', () => {
    expect(Cap.agentTransfer).toBe('ovo.agent-transfer');
    expect(CAPABILITY_SPECS[Cap.agentTransfer]).toEqual({
      major: 1,
      cardinality: 'one',
      scope: 'session',
    });
    const port: CapabilityMap[typeof Cap.agentTransfer] = {
      targets: () => [{ key: 'billing', description: 'Payments', confirm: 'never' }],
      request: async () => ({ ok: false, reason: 'not_granted' }),
      commit: () => {},
      cancel: async () => {},
    } satisfies AgentTransferPort;
    expect(port.inbound).toBeUndefined();
    expect(AGENT_TRANSFER_REFUSALS).toHaveLength(14);
  });
});

describe('transfer session events', () => {
  const requested = {
    transfer: 1,
    fromSegment: 1,
    source: 'llm',
    kind: 'agent',
    key: 'billing',
    result: 'accepted',
  };
  const completed = { transfer: 1, outcome: 'connected', toSegment: 2, holdMs: 4_100 };
  const ended = {
    index: 1,
    role: 'agent',
    agentId: 'sales-en',
    releaseId: SALES_EN_RELEASE,
    ended: 'handoff',
    endReason: 'behavior_completed',
    durationMs: 61_000,
    turns: 4,
    usage: { 'stt.seconds': 58 },
  };

  it('appends the four R2 types and validates each payload', () => {
    expect(SESSION_EVENT_TYPES.slice(-4)).toEqual([
      'transfer.requested',
      'transfer.completed',
      'segment.ended',
      'disclosure',
    ]);
    expect(readSessionEvent('transfer.requested', requested).type).toBe('transfer.requested');
    expect(TransferCompletedPayload.parse(completed).steps).toEqual([]);
    expect(readSessionEvent('segment.ended', ended).type).toBe('segment.ended');
    expect(readSessionEvent('disclosure', { kinds: ['recording'], segment: 0 }).type).toBe(
      'disclosure',
    );
  });

  it('refuses malformed R2 payloads', () => {
    for (const [type, bad] of [
      ['transfer.requested', { ...requested, transfer: 0 }],
      ['transfer.requested', { ...requested, source: 'caller' }],
      ['transfer.requested', { ...requested, result: 'maybe' }],
      ['transfer.requested', { ...requested, refusal: 'x'.repeat(81) }],
      ['transfer.completed', { ...completed, outcome: 'magic' }],
      ['transfer.completed', { ...completed, holdMs: -1 }],
      ['transfer.completed', { ...completed, steps: [{ step: 'pray', result: 'taken' }] }],
      [
        'transfer.completed',
        {
          ...completed,
          steps: Array.from({ length: 9 }, () => ({ step: 'default', result: 'failed' })),
        },
      ],
      ['segment.ended', { ...ended, ended: 'paused' }],
      [
        'segment.ended',
        { ...ended, usage: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`m${i}`, 1])) },
      ],
      ['disclosure', { kinds: [] }],
      ['disclosure', { kinds: ['legal'] }],
    ] as const)
      expect(() => readSessionEvent(type, bad), `${type} ${JSON.stringify(bad)}`).toThrow();
  });

  it('keeps the 8 KiB cap on R2 events', () => {
    expect(() =>
      readSessionEvent('transfer.completed', {
        ...completed,
        note: 'x'.repeat(SESSION_EVENT_MAX_BYTES),
      }),
    ).toThrow(/limit/);
  });

  it('has no free-text field for caller words or the LLM summary', () => {
    for (const schema of [
      TransferRequestedPayload,
      TransferCompletedPayload,
      SegmentEndedPayload,
      DisclosurePayload,
    ])
      for (const field of ['summary', 'transcript', 'text', 'words', 'utterance'])
        expect(Object.keys(schema.shape)).not.toContain(field);
    expect(Object.keys(TransferRequestedPayload.shape)).not.toContain('reason');
  });

  it('extends route.segment reasons and route.fallback steps', () => {
    const segment = {
      index: 2,
      role: 'agent',
      agentId: 'billing',
      releaseId: SALES_EN_RELEASE,
      reason: 'transfer',
      transfer: 1,
      language: 'en',
      fromIndex: 1,
    };
    expect(RouteSegmentPayload.parse(segment).transfer).toBe(1);
    for (const reason of ['return', 'reroute'])
      expect(RouteSegmentPayload.safeParse({ ...segment, reason }).success).toBe(true);
    expect(RouteSegmentPayload.safeParse({ ...segment, transfer: 0 }).success).toBe(false);
    expect(RouteSegmentPayload.safeParse({ ...segment, reason: 'magic' }).success).toBe(false);
    expect(
      RouteFallbackPayload.parse({
        turn: 1,
        node: 'intent',
        step: 'target',
        result: 'failed',
        attempt: 1,
        reason: 'pool_full',
      }).step,
    ).toBe('target');
  });
});
