import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { PostgresCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { buildManagementApi } from '../src/server.ts';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const at = '2026-10-20T10:00:00.000Z';
const POINT = '11111111-1111-4111-8111-111111111111';
const POINT_B = '11111111-1111-4111-8111-222222222222';
const POINT_GONE = '11111111-1111-4111-8111-333333333333';
const RELEASE = '22222222-2222-4222-8222-222222222222';
const POOL = '33333333-3333-4333-8333-333333333333';
const R1 = '44444444-4444-4444-8444-444444444444';
const R2 = '55555555-5555-4555-8555-555555555555';
const QUEUE = 'abcdef01-0000-4000-8000-000000000001';

type Step = readonly [string, Record<string, unknown>];
const segment = (index: number, extra: Record<string, unknown>): Step => [
  'route.segment',
  { index, role: 'agent', agentId: 'sales', releaseId: R1, reason: 'route', ...extra },
];
const decision = (point: string, extra: Record<string, unknown> = {}): Step => [
  'route.decision',
  {
    routingPointId: point,
    routingReleaseId: RELEASE,
    path: ['intent'],
    target: 'agent',
    agentId: 'sales',
    releaseId: R1,
    poolId: POOL,
    memberId: 'm1',
    turns: 2,
    routeMs: 1_000,
    ...extra,
  },
];
const router: Step = segment(0, { role: 'router', agentId: 'front-desk', reason: 'start' });

/** A call that fell back to the default, then transferred to billing. */
const TRANSFERRED: Step[] = [
  router,
  ['route.fallback', { turn: 1, node: 'intent', step: 'default', result: 'taken', attempt: 1 }],
  decision(POINT),
  segment(1, { poolId: POOL, memberId: 'm1' }),
  ['turn.route', { turn: 1, tier: 'llm', intent: 'billing', confidence: 0.9 }],
  [
    'transfer.requested',
    {
      transfer: 1,
      fromSegment: 1,
      source: 'llm',
      kind: 'agent',
      key: 'billing',
      result: 'accepted',
    },
  ],
  segment(2, { agentId: 'billing', releaseId: R2, reason: 'transfer', transfer: 1 }),
  [
    'transfer.completed',
    {
      transfer: 1,
      outcome: 'connected',
      toSegment: 2,
      agentId: 'billing',
      releaseId: R2,
      holdMs: 100,
      steps: [],
    },
  ],
  [
    'segment.ended',
    {
      index: 1,
      role: 'agent',
      agentId: 'sales',
      releaseId: R1,
      ended: 'handoff',
      endReason: 'behavior_completed',
      durationMs: 5000,
      turns: 2,
    },
  ],
  ['disclosure', { kinds: ['ai'], segment: 1 }],
  ['call.outcome', { outcome: 'completed', reason: 'caller_hangup' }],
];
const PERSON: Step[] = [
  router,
  decision(POINT_B, {
    target: 'human',
    agentId: undefined,
    releaseId: undefined,
    poolId: undefined,
    memberId: undefined,
  }),
  [
    'human.requested',
    {
      queue: 'floor',
      queueId: QUEUE,
      kind: 'managed',
      ticket: 't1',
      source: 'router',
      result: 'accepted',
    },
  ],
  ['human.state', { ticket: 't1', state: 'connected', by: 'worker', operator: 'u1', waitMs: 1000 }],
  ['call.outcome', { outcome: 'completed', reason: 'caller_hangup' }],
];
const CLEAN: Step[] = [
  router,
  decision(POINT),
  segment(1, { poolId: POOL, memberId: 'm2' }),
  ['call.outcome', { outcome: 'completed', reason: 'caller_hangup' }],
];

/** The steps as session events, all stamped `minute` past the hour, so the outcome order is the test's. */
const events = (steps: readonly Step[], prefix: string, minute: number) =>
  steps.map(([type, payload], index) => ({
    id: `${prefix}-${index}`,
    at: `2026-10-20T10:0${minute}:00.000Z`,
    type,
    payload,
  }));

describe.skipIf(!databaseUrl)(
  'routing filters, timeline events and transcript segments through the PostgreSQL API (R4)',
  () => {
    it('lists calls by the route they took, pages them, and tags the transcript by segment', async () => {
      const workspaceId = `routing-calls-${randomUUID()}`;
      const headers = { authorization: 'Bearer routing-calls-token' };
      const { app, composition } = await buildManagementApi({
        storageAdapter: 'postgres',
        controlDatabaseUrl: databaseUrl,
        storageMaxConnections: 4,
        secretBackend: 'encrypted-store',
        secretsMasterKey: Buffer.alloc(32, 9).toString('base64'),
        sessionSecret: 'routing-calls-session',
        pluginCatalog: [selectedSpeechFixture],
        identities: [
          {
            id: 'operator',
            label: 'Operator',
            token: 'routing-calls-token',
            defaultWorkspaceId: workspaceId,
            workspaces: { [workspaceId]: 'admin' },
          },
        ],
      });
      const outcomes = await PostgresCallOutcomeStore.open({ connectionString: databaseUrl! });
      const get = (url: string) => app.inject({ method: 'GET', url, headers });
      const ids = async (query: string) => {
        const response = await get(`/v1/calls?${query}`);
        expect(response.statusCode, response.body).toBe(200);
        return response.json().items.map((item: { id: string }) => item.id) as string[];
      };
      try {
        const store = composition.ctx.get('controlStore') as ControlStore;
        const agent = await app.inject({
          method: 'POST',
          url: '/v1/agents',
          headers,
          payload: {
            config: {
              name: 'Routed',
              mode: 'announcement',
              message: 'Hello.',
              voice: selectedSpeechVoice,
            },
          },
        });
        const release = await app.inject({
          method: 'POST',
          url: `/v1/agents/${agent.json().id}/releases`,
          headers,
          payload: {},
        });
        expect(release.statusCode, release.body).toBe(201);
        const make = (status = 'completed') =>
          store.createCall({ workspaceId, releaseId: release.json().id, kind: 'live', status });
        const transferred = await make();
        const person = await make('failed');
        const clean = await make();
        const direct = await make();
        const stale = `${workspaceId}-gone`;
        await outcomes.append(workspaceId, transferred.id, events(TRANSFERRED, 't', 1));
        await outcomes.append(workspaceId, person.id, events(PERSON, 'p', 2));
        await outcomes.append(workspaceId, clean.id, events(CLEAN, 'c', 3));
        // An outcome whose call the control store no longer has is dropped, not an error.
        await outcomes.append(workspaceId, stale, events([router, decision(POINT_GONE)], 's', 4));
        await outcomes.append(workspaceId, direct.id, [
          { id: 'd0', at, type: 'call.outcome', payload: { outcome: 'completed', reason: 'x' } },
        ]);
        expect(await ids(`routingPointId=${POINT_GONE}`)).toEqual([]);

        expect((await ids('')).sort()).toEqual(
          [transferred.id, person.id, clean.id, direct.id].sort(),
        );
        expect(new Set(await ids(`routingPointId=${POINT}`))).toEqual(
          new Set([transferred.id, clean.id]),
        );
        expect(await ids(`routingPointId=${POINT_B}`)).toEqual([person.id]);
        expect(await ids('transferred=1')).toEqual([transferred.id]);
        expect(await ids('human=1')).toEqual([person.id]);
        expect(await ids('fallback=1')).toEqual([transferred.id]);
        expect(await ids('segmentAgentId=billing')).toEqual([transferred.id]);
        expect(new Set(await ids(`poolId=${POOL}`))).toEqual(new Set([transferred.id, clean.id]));
        expect(await ids(`routingPointId=${POINT}&transferred=true&fallback=1`)).toEqual([
          transferred.id,
        ]);
        expect(await ids(`routingPointId=${POINT}&status=failed`)).toEqual([]);
        expect(await ids('human=1&status=failed&kind=live')).toEqual([person.id]);
        expect(await ids('human=1&kind=test')).toEqual([]);

        // Each listed call carries its outcome; newest outcome first, walked one at a time.
        const first = await get('/v1/calls?routingPointId=' + POINT + '&limit=1');
        expect(first.json()).toMatchObject({
          items: [{ id: clean.id, outcome: { route: { routingPointId: POINT } } }],
        });
        const next = await get(
          `/v1/calls?routingPointId=${POINT}&limit=1&cursor=${first.json().nextCursor}`,
        );
        expect(next.json().items.map((item: { id: string }) => item.id)).toEqual([transferred.id]);
        expect(next.json().nextCursor).toBeNull();

        for (const query of [
          'transferred=1&agentId=' + randomUUID(),
          'human=1&engine=x',
          'fallback=1&carrier=y',
          'human=1&order=asc',
        ]) {
          const refused = await get(`/v1/calls?${query}`);
          expect([refused.statusCode, refused.json().error.code], query).toEqual([
            422,
            'routing_filter_unsupported',
          ]);
        }
        for (const query of ['routingPointId=nope', 'transferred=0', 'human=yes', 'poolId=x'])
          expect((await get(`/v1/calls?${query}`)).statusCode, query).toBe(400);

        // The timeline events of the segments route: the allowlist, in order, validated.
        const segments = (await get(`/v1/calls/${transferred.id}/segments`)).json();
        expect(segments.events.map((event: { type: string }) => event.type)).toEqual([
          'route.segment',
          'route.fallback',
          'route.decision',
          'route.segment',
          'transfer.requested',
          'route.segment',
          'transfer.completed',
          'segment.ended',
          'disclosure',
        ]);
        expect(segments.events[0]).toMatchObject({
          sequence: 1,
          at: '2026-10-20T10:01:00.000Z',
          payload: { index: 0, role: 'router' },
        });
        expect(segments.events.at(-1)).toMatchObject({ type: 'disclosure', segment: 1 });
        expect(segments.eventsTruncated).toBe(false);
        const human = (await get(`/v1/calls/${person.id}/segments`)).json();
        expect(human.events.map((event: { type: string }) => event.type)).toEqual([
          'route.segment',
          'route.decision',
          'human.requested',
          'human.state',
        ]);

        // The transcript is tagged with the segment the worker stamped on each engine event.
        await store.appendCallEvent(workspaceId, transferred.id, 'engine.event', {
          event: {
            type: 'user.transcript',
            turnId: 'turn-1',
            segmentId: 'seg-1',
            text: 'I need billing',
            stability: 'final',
          },
          atMs: 10,
          segment: 1,
        });
        await store.appendCallEvent(workspaceId, transferred.id, 'engine.event', {
          event: {
            type: 'agent.transcript',
            segmentId: 's2:seg-1',
            text: 'Billing here',
            state: 'played',
          },
          atMs: 20,
          segment: 2,
        });
        await store.appendCallEvent(workspaceId, transferred.id, 'engine.event', {
          event: {
            type: 'agent.transcript',
            segmentId: 'untagged',
            text: 'No stamp',
            state: 'played',
          },
          atMs: 30,
        });
        const evidence = (await get(`/v1/calls/${transferred.id}/evidence`)).json();
        expect(
          evidence.transcript.map((entry: { text: string; segment?: number }) => [
            entry.text,
            entry.segment,
          ]),
        ).toEqual([
          ['I need billing', 1],
          ['Billing here', 2],
          ['No stamp', undefined],
        ]);
      } finally {
        await outcomes.close();
        await app.close();
        await composition.dispose();
      }
    }, 30_000);
  },
);

describe('routing filters without an outcomes store (R4)', () => {
  it('says the filter is unavailable rather than listing every call', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ovo-routing-calls-'));
    const { app } = await buildManagementApi({
      databaseFile: join(directory, 'control.sqlite'),
      secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
      sessionSecret: 'routing-calls-sqlite-session',
      requireTlsForSecrets: false,
      identities: [
        {
          id: 'viewer',
          label: 'Viewer',
          token: 'sqlite-viewer',
          defaultWorkspaceId: 'demo',
          workspaces: { demo: 'viewer' },
        },
      ],
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/calls?human=1',
        headers: { authorization: 'Bearer sqlite-viewer' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ items: [], nextCursor: null, filterUnavailable: true });
      const plain = await app.inject({
        method: 'GET',
        url: '/v1/calls',
        headers: { authorization: 'Bearer sqlite-viewer' },
      });
      expect(plain.json()).not.toHaveProperty('filterUnavailable');
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
