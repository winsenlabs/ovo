import { describe, expect, it, vi } from 'vitest';
import type { NormalizedCallEvent } from '@winsendotai/ovo-contracts';
import { fixtureCarrierIngress } from '../../../packages/conformance/src/drivers/fixture-carrier.ts';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { createGatewayHost } from '../src/gateway-host.ts';

it.each([
  ['completed', undefined, false, 'failed'],
  ['completed', 'machine', true, 'failed'],
  ['completed', 'human', true, 'succeeded'],
  ['busy', undefined, false, 'failed'],
] as const)(
  'projects %s with answeredBy %s and sessionOpened %s as %s through host.applyCallEvent',
  async (state, answeredBy, sessionOpened, expected) => {
    const recordAttempt = vi.fn(async () => undefined);
    const route = {
      jobId: 'job-1',
      sessionId: 'session-1',
      organizationId: 'org',
      handshakeClaimedAt: new Date(1),
    };
    const store = {
      pool: {
        query: vi.fn(async () => ({
          rows: [{ session_opened: sessionOpened, machine_answered: answeredBy === 'machine' }],
        })),
      },
      applyCarrierCallback: vi.fn(async () => ({ kind: 'applied' as const, route })),
      get: vi.fn(async () => ({ payload: { kind: 'outbound_call', attemptId: 'attempt-1' } })),
      resolveSessionRoute: vi.fn(),
      issueStreamGrant: vi.fn(),
      reissueStream: vi.fn(),
      recordCarrierCallIdMismatch: vi.fn(),
    };
    const operations = {
      organizationId: 'org',
      campaigns: { recordAttempt },
      inboundGateway: {},
    };
    const { hostFor } = createGatewayHost({
      publicBaseUrl: 'https://voice.example',
      routeSecret: 'a'.repeat(32),
      store: store as never,
      operations: operations as never,
      distribution: { catalog: [], defaults: {} } as never,
      control: {} as never,
      secrets: {} as never,
      ingresses: [fixtureCarrierIngress()],
      env: {},
    });
    const event: NormalizedCallEvent = {
      carrierId: 'fixture',
      bindingId: 'env',
      eventId: 'event-1',
      carrierCallId: 'call-1',
      state,
      ...(answeredBy ? { answeredBy } : {}),
      occurredAt: new Date(2),
    };
    expect(await hostFor('fixture', 'env').applyCallEvent(event)).toEqual({ kind: 'applied' });
    expect(recordAttempt).toHaveBeenCalledWith(
      'attempt-1',
      'event-1',
      expected,
      event.occurredAt,
      // The retry policy's reason: busy backs off 30 minutes, a machine answer a day, and an
      // answer with no agent session is never retried.
      state === 'busy'
        ? 'busy'
        : answeredBy === 'machine'
          ? 'voicemail'
          : sessionOpened
            ? undefined
            : 'completed_without_session',
    );
    expect(store.applyCarrierCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org',
        carrierId: 'fixture',
        status: state === 'completed' ? 'completed' : 'busy',
      }),
    );
  },
);

it('keeps an earlier verified machine answer when completion omits answeredBy', async () => {
  const callbacks: NormalizedCallEvent[] = [];
  const recordAttempt = vi.fn(async () => undefined);
  const route = { sessionId: 'session-1', jobId: 'job-1', organizationId: 'org' };
  const store = {
    pool: {
      query: vi.fn(async () => ({
        rows: [
          {
            session_opened: true,
            machine_answered: callbacks.some((event) => event.answeredBy === 'machine'),
          },
        ],
      })),
    },
    applyCarrierCallback: vi.fn(async (input: { eventId: string }) => {
      callbacks.push({
        eventId: input.eventId,
        answeredBy: input.eventId === 'machine' ? 'machine' : undefined,
      } as NormalizedCallEvent);
      return { kind: 'applied' as const, route };
    }),
    get: vi.fn(async () => ({ payload: { kind: 'outbound_call', attemptId: 'attempt-1' } })),
    resolveSessionRoute: vi.fn(),
    issueStreamGrant: vi.fn(),
    reissueStream: vi.fn(),
    recordCarrierCallIdMismatch: vi.fn(),
  };
  const { hostFor } = createGatewayHost({
    publicBaseUrl: 'https://voice.example',
    routeSecret: 'a'.repeat(32),
    store: store as never,
    operations: {
      organizationId: 'org',
      campaigns: { recordAttempt },
      inboundGateway: {},
    } as never,
    distribution: { catalog: [], defaults: {} } as never,
    control: {} as never,
    secrets: {} as never,
    ingresses: [fixtureCarrierIngress()],
    env: {},
  });
  await hostFor('fixture', 'env').applyCallEvent({
    carrierId: 'fixture',
    bindingId: 'env',
    eventId: 'machine',
    carrierCallId: 'call-1',
    state: 'in_progress',
    answeredBy: 'machine',
    occurredAt: new Date(1),
  });
  await hostFor('fixture', 'env').applyCallEvent({
    carrierId: 'fixture',
    bindingId: 'env',
    eventId: 'completed',
    carrierCallId: 'call-1',
    state: 'completed',
    occurredAt: new Date(2),
  });
  expect(recordAttempt).toHaveBeenLastCalledWith(
    'attempt-1',
    'completed',
    'failed',
    new Date(2),
    'voicemail',
  );
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('durable campaign callback history', () => {
  it.each([
    ['foreign machine rows are excluded', false, 'succeeded'],
    ['an earlier verified machine answer is included', true, 'failed'],
  ] as const)('%s', async (_label, localMachine, expected) => {
    const durable = new PostgresOrchestrationStore({ connectionString: postgresUrl, max: 1 });
    const sessionId = 'session-1';
    const recordAttempt = vi.fn(async () => undefined);
    const route = { sessionId, jobId: 'job-1', organizationId: 'org' };
    try {
      await durable.pool.query(`CREATE TEMP TABLE ovo_carrier_callbacks (
      organization_id text, carrier_id text, session_id text,
      provider text, status text, payload jsonb)`);
      await durable.pool.query(
        `INSERT INTO ovo_carrier_callbacks VALUES
       ('org', 'fixture', $1, 'ovo.media', 'session_opened', '{}'::jsonb),
       ('other-org', 'fixture', $1, 'fixture', 'answered', '{"answeredBy":"machine"}'::jsonb),
       ('org', 'fixture', 'other-session', 'fixture', 'answered', '{"answeredBy":"machine"}'::jsonb)`,
        [sessionId],
      );
      const store = {
        pool: durable.pool,
        applyCarrierCallback: vi.fn(async (event: { eventId: string; payload: object }) => {
          if (event.eventId === 'machine')
            await durable.pool.query(
              `INSERT INTO ovo_carrier_callbacks VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
              ['org', 'fixture', sessionId, 'fixture', 'answered', JSON.stringify(event.payload)],
            );
          return { kind: 'applied' as const, route };
        }),
        get: vi.fn(async () => ({ payload: { kind: 'outbound_call', attemptId: 'attempt-1' } })),
        resolveSessionRoute: vi.fn(),
        issueStreamGrant: vi.fn(),
        reissueStream: vi.fn(),
        recordCarrierCallIdMismatch: vi.fn(),
      };
      const { hostFor } = createGatewayHost({
        publicBaseUrl: 'https://voice.example',
        routeSecret: 'a'.repeat(32),
        store: store as never,
        operations: {
          organizationId: 'org',
          campaigns: { recordAttempt },
          inboundGateway: {},
        } as never,
        distribution: { catalog: [], defaults: {} } as never,
        control: {} as never,
        secrets: {} as never,
        ingresses: [fixtureCarrierIngress()],
        env: {},
      });
      const host = hostFor('fixture', 'env');
      const event = (
        eventId: string,
        state: NormalizedCallEvent['state'],
        answeredBy?: 'machine',
      ): NormalizedCallEvent => ({
        carrierId: 'fixture',
        bindingId: 'env',
        eventId,
        carrierCallId: 'call-1',
        state,
        ...(answeredBy ? { answeredBy } : {}),
        occurredAt: new Date(2),
      });
      if (localMachine) await host.applyCallEvent(event('machine', 'in_progress', 'machine'));
      await host.applyCallEvent(event('completed', 'completed'));
      expect(recordAttempt).toHaveBeenLastCalledWith(
        'attempt-1',
        'completed',
        expected,
        new Date(2),
        // The retry policy's reason: a machine answer backs off a day.
        expected === 'failed' ? 'voicemail' : undefined,
      );
    } finally {
      await durable.close();
    }
  });
});
