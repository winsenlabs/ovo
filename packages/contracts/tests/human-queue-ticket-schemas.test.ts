import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CALL_OUTCOME_MAX_PATH,
  Cap,
  CAPABILITY_SPECS,
  CaptionMessage,
  DeskAcceptResult,
  DeskCommand,
  HUMAN_METER_KEYS,
  HumanCompletedPayload,
  HumanRequestedPayload,
  HumanStatePayload,
  HumanTicketView,
  HumanWebhookPayload,
  OperatorProfile,
  readSessionEvent,
  RoomGrant,
  SegmentHandoffRequest,
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_TYPES,
  TicketContext,
  WrapUp,
  type CapabilityMap,
  type HandoffTarget,
  type MediaRoomProvider,
} from '../src/index.ts';
import { QUEUE_EXT } from './human-queue-fixture.ts';

const NOW = '2026-10-15T10:00:00.000Z';

describe('ticket, operator and desk shapes', () => {
  const view = {
    id: QUEUE_EXT,
    queueId: QUEUE_EXT,
    queueKey: 'floor',
    queueName: 'Floor',
    kind: 'managed',
    mode: 'OPEN_PICKUP',
    status: 'waiting',
    version: 1,
    priority: 0,
    createdAt: NOW,
    waitMs: 1_200,
    offeredToMe: false,
  };

  it('parses an operator ticket view with its optional fields', () => {
    expect(HumanTicketView.parse(view).callerMasked).toBeUndefined();
    expect(
      HumanTicketView.parse({
        ...view,
        status: 'released',
        releaseCode: 'handed_off',
        language: 'hi',
        callerMasked: '+91******21',
        releasedAt: NOW,
      }).releaseCode,
    ).toBe('handed_off');
    for (const bad of [
      { ...view, status: 'open' },
      { ...view, waitMs: -1 },
      { ...view, releaseCode: 'because' },
      { ...view, createdAt: 'yesterday' },
      { ...view, callerNumber: '+919800000000' },
      { ...view, queueKey: 'Floor' },
    ])
      expect(HumanTicketView.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('keeps the full number out of the ticket view and in the accepted context', () => {
    expect(Object.keys(HumanTicketView.shape)).not.toContain('caller');
    const context = TicketContext.parse({
      callId: 'job-1',
      brief: 'Language: Hindi. Intent: billing.',
      routePath: ['intent', 'billing'],
      caller: { number: '+919800000000' },
      transcript: [{ role: 'caller', text: 'hello' }],
      variables: { account: 'A1', age: 4, vip: true },
      returnTargets: [{ key: 'support', label: 'Support' }],
    });
    expect(context.caller.number).toBe('+919800000000');
    for (const bad of [
      { ...context, brief: 'x'.repeat(401) },
      { ...context, summary: 'x'.repeat(1_001) },
      { ...context, transcript: Array.from({ length: 41 }, () => ({ role: 'agent', text: 't' })) },
      { ...context, transcript: [{ role: 'operator', text: 't' }] },
      { ...context, variables: { a: { nested: 1 } } },
      {
        ...context,
        returnTargets: Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, label: 'l' })),
      },
    ])
      expect(TicketContext.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
  });

  it('validates an operator profile', () => {
    const profile = {
      userId: 'u1',
      displayName: 'Asha',
      enabled: true,
      teamIds: ['support'],
      languages: ['en', 'hi'],
      capacity: 2,
    };
    expect(OperatorProfile.parse(profile).capacity).toBe(2);
    for (const bad of [
      { ...profile, capacity: 21 },
      { ...profile, capacity: -1 },
      { ...profile, teamIds: ['Support'] },
      { ...profile, languages: ['english'] },
      { ...profile, userId: '' },
      { ...profile, role: 'admin' },
    ])
      expect(OperatorProfile.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('validates a room grant and the accept result that carries it', () => {
    const grant = {
      provider: 'room',
      serverUrl: 'wss://rooms.example.com',
      roomName: 'ovo-hq-1',
      identity: 'op:u1',
      role: 'operator',
      token: 'jwt',
      expiresAt: NOW,
    };
    expect(RoomGrant.parse(grant).role).toBe('operator');
    expect(RoomGrant.safeParse({ ...grant, role: 'admin' }).success).toBe(false);
    expect(RoomGrant.safeParse({ ...grant, serverUrl: 'rooms' }).success).toBe(false);
    expect(DeskAcceptResult.safeParse({ ticket: view, room: grant }).success).toBe(false);
  });

  it('validates operator commands and wrap-up', () => {
    expect(DeskCommand.parse({ kind: 'end_call' })).toEqual({ kind: 'end_call' });
    expect(DeskCommand.parse({ kind: 'return_to_agent', target: 'support' }).kind).toBe(
      'return_to_agent',
    );
    for (const bad of [
      { kind: 'return_to_agent' },
      { kind: 'return_to_agent', target: 'Support' },
      { kind: 'end_call', target: 'support' },
      { kind: 'whisper' },
    ])
      expect(DeskCommand.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(WrapUp.parse({})).toEqual({});
    expect(WrapUp.safeParse({ disposition: ' ' }).success).toBe(false);
    expect(WrapUp.safeParse({ note: 'x'.repeat(1_001) }).success).toBe(false);
  });

  it('validates captions', () => {
    expect(CaptionMessage.parse({ role: 'caller', text: 'hi', final: false, at: 0 }).final).toBe(
      false,
    );
    expect(
      CaptionMessage.safeParse({ role: 'caller', text: 'hi', final: false, at: -1 }).success,
    ).toBe(false);
    expect(
      CaptionMessage.safeParse({ role: 'robot', text: 'hi', final: true, at: 1 }).success,
    ).toBe(false);
  });
});

describe('runtime contracts the lanes build on', () => {
  it('accepts a human segment handoff request that names a queue key', () => {
    const request = SegmentHandoffRequest.parse({
      kind: 'human',
      reason: 'route',
      queueId: 'support-desk',
      route: { path: ['intent'] },
      transfer: { source: 'router' },
    });
    expect(request).toMatchObject({ kind: 'human', variables: {} });
    for (const bad of [
      { kind: 'human', reason: 'route' },
      { kind: 'human', reason: 'reroute', queueId: 'q' },
      { kind: 'human', reason: 'route', queueId: 'Q' },
      { kind: 'human', reason: 'route', queueId: 'q', variables: { account: '1' } },
      { kind: 'human', reason: 'route', queueId: 'q', agentId: 'sales' },
    ])
      expect(SegmentHandoffRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('registers the media-room capability as a process-scoped key', () => {
    expect(Cap.mediaRoom).toBe('ovo.media-room');
    expect(CAPABILITY_SPECS[Cap.mediaRoom]).toEqual({
      major: 1,
      cardinality: 'one',
      scope: 'process',
    });
    expectTypeOf<CapabilityMap[typeof Cap.mediaRoom]>().toEqualTypeOf<MediaRoomProvider>();
  });

  it('carries a sip handoff target with X- headers', () => {
    const target: HandoffTarget = {
      kind: 'sip',
      uri: 'sips:agent7@acd.example.com',
      headers: { 'X-OVO-Ticket': 't1' },
    };
    expect(target.kind).toBe('sip');
    const bare: HandoffTarget = { kind: 'sip', uri: 'sip:a@b.example' };
    expect(bare.kind).toBe('sip');
  });

  it('names the two human meters as unit-seconds host meters', () => {
    expect(HUMAN_METER_KEYS).toEqual({
      operatorSeconds: 'ovo.human.operator_seconds',
      roomSeconds: 'ovo.human.room_seconds',
    });
  });
});

describe('human session events', () => {
  it('appends the four human types after the R2 events', () => {
    expect(SESSION_EVENT_TYPES.slice(-4)).toEqual([
      'human.requested',
      'human.state',
      'human.webhook',
      'human.completed',
    ]);
    expect(CALL_OUTCOME_MAX_PATH).toBeGreaterThan(0);
  });

  it('validates each payload and keeps a newer emitter extra field', () => {
    const requested = {
      queue: 'support-desk',
      queueId: QUEUE_EXT,
      kind: 'external',
      ticket: 't1',
      source: 'router',
      result: 'accepted',
    };
    expect(readSessionEvent('human.requested', { ...requested, newer: 1 }).payload).toMatchObject({
      newer: 1,
    });
    expect(
      readSessionEvent('human.state', { ticket: 't1', state: 'offered', by: 'sweeper', version: 2 })
        .type,
    ).toBe('human.state');
    expect(
      readSessionEvent('human.webhook', {
        ticket: 't1',
        attempt: 2,
        outcome: 'retry',
        status: 503,
        ms: 41,
        reason: 'http_503',
      }).type,
    ).toBe('human.webhook');
    expect(
      readSessionEvent('human.completed', {
        ticket: 't1',
        queue: 'support-desk',
        kind: 'managed',
        outcome: 'returned',
        waitMs: 5_000,
        talkMs: 60_000,
        operator: 'u1',
        segment: 2,
        steps: ['human:taken'],
      }).type,
    ).toBe('human.completed');
  });

  it('refuses malformed human payloads', () => {
    const requested = {
      queue: 'q',
      queueId: 'id',
      kind: 'external',
      source: 'router',
      result: 'accepted',
    };
    for (const [schema, bad] of [
      [HumanRequestedPayload, { ...requested, kind: 'carrier' }],
      [HumanRequestedPayload, { ...requested, source: 'magic' }],
      [HumanRequestedPayload, { ...requested, result: 'maybe' }],
      [HumanRequestedPayload, { ...requested, priority: 10 }],
      [HumanStatePayload, { ticket: 't', state: 'dancing', by: 'worker' }],
      [HumanStatePayload, { ticket: 't', state: 'waiting', by: 'nobody' }],
      [HumanStatePayload, { state: 'waiting', by: 'worker' }],
      [HumanWebhookPayload, { ticket: 't', attempt: 0, outcome: 'retry', ms: 1 }],
      [HumanWebhookPayload, { ticket: 't', attempt: 1, outcome: 'exploded', ms: 1 }],
      [HumanWebhookPayload, { ticket: 't', attempt: 1, outcome: 'retry', ms: -1 }],
      [
        HumanCompletedPayload,
        { ticket: 't', queue: 'q', kind: 'managed', outcome: 'won', waitMs: 1 },
      ],
      [HumanCompletedPayload, { ticket: 't', queue: 'q', kind: 'managed', outcome: 'ended' }],
    ] as const)
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('keeps the 8 KiB cap on human events', () => {
    const state = {
      ticket: 't',
      state: 'waiting',
      by: 'worker',
      note: 'x'.repeat(SESSION_EVENT_MAX_BYTES),
    };
    expect(HumanStatePayload.safeParse(state).success).toBe(true);
    expect(() => readSessionEvent('human.state', state)).toThrow(/limit/);
  });
});
