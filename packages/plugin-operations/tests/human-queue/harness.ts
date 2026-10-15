import { afterEach, beforeEach } from 'vitest';
import {
  HumanQueueDefinition,
  type HumanQueue,
  type OperatorProfile,
  type TicketContext,
} from '@winsendotai/ovo-contracts';
import type { HumanQueueService, NewTicket, Ticket } from '../../src/human-queue/service.ts';

export const T0 = new Date('2026-10-15T09:00:00.000Z');

/** What a store under test offers the shared suite. */
export interface HqHarness {
  /** The organization the service is scoped to (workspace id of its tickets). */
  org: string;
  service: HumanQueueService;
  clock: { now(): Date; advance(ms: number): void; set(date: Date): void };
  /** A live routing point whose draft binds these queues (undefined: the point is gone). */
  bindPoint(pointId: string, queueIds: readonly string[] | undefined): Promise<void>;
  /** The state events of a ticket, oldest first. */
  events(
    ticketId: string,
  ): Promise<{ kind: string; sourceEventId?: string; payload: Record<string, unknown> }[]>;
  /** Releases the schema, pool or anything else the harness holds. */
  close(): Promise<void>;
}

export const context = (patch: Partial<TicketContext> = {}): TicketContext => ({
  callId: 'call',
  brief: 'Language: English. Intent: billing.',
  summary: 'Caller asks about a charge.',
  language: 'en',
  routePath: ['intent', 'billing'],
  caller: { number: '+919800000000' },
  transcript: [{ role: 'caller', text: 'I want a person' }],
  variables: { account: 'A1' },
  returnTargets: [],
  ...patch,
});

let counter = 0;
export const next = () => (counter += 1);

export function managedDefinition(patch: Record<string, unknown> = {}) {
  return HumanQueueDefinition.parse({ kind: 'managed', name: `Floor ${next()}`, ...patch });
}

export function externalDefinition(patch: Record<string, unknown> = {}) {
  return HumanQueueDefinition.parse({
    kind: 'external',
    name: `ACD ${next()}`,
    webhook: { url: 'https://acd.example.com/h', credentialId: 'c' },
    destination: { allowE164Prefixes: ['+91'] },
    ...patch,
  });
}

/** A ticket for a queue, as the worker would write it from the pinned definition. */
export function ticketFor(queue: HumanQueue, patch: Partial<NewTicket> = {}): NewTicket {
  const { definition } = queue;
  const callId = `call-${next()}`;
  return {
    callId,
    idempotencyKey: `hq:org:${callId}:1`,
    queue: {
      id: queue.id,
      key: 'floor',
      name: definition.name,
      kind: definition.kind,
      mode: definition.kind === 'managed' ? definition.assignment : 'OPEN_PICKUP',
      teamIds: definition.kind === 'managed' ? definition.teamIds : [],
      language: definition.kind === 'managed' ? definition.language : 'ignore',
      maxWaiting: definition.limits.maxWaiting,
    },
    priority: 0,
    language: 'en',
    callerMasked: '+91••••00',
    expiresAt: new Date(T0.getTime() + 180_000).toISOString(),
    routerAgentId: 'front-desk',
    context: context({ callId }),
    contextRetentionHours: 24,
    ...patch,
  };
}

export const profile = (userId: string, patch: Partial<OperatorProfile> = {}): OperatorProfile => ({
  userId,
  displayName: userId.toUpperCase(),
  enabled: true,
  teamIds: [],
  languages: ['en'],
  capacity: 1,
  ...patch,
});

/** A fresh harness for each test; the returned object always reads the current one. */
export function useHarness(make: () => Promise<HqHarness>): HqHarness {
  let current: HqHarness | undefined;
  beforeEach(async () => {
    current = await make();
  });
  afterEach(() => current?.close());
  return new Proxy({} as HqHarness, {
    get: (_, key) => (current as unknown as Record<string | symbol, unknown>)[key],
  });
}

/** The moves every ticket test makes, bound to the harness of the running test. */
export function ticketKit(h: HqHarness) {
  const tickets = () => h.service.tickets;
  return {
    tickets,
    queueOf: (patch: Record<string, unknown> = {}): Promise<HumanQueue> =>
      h.service.queues.create(managedDefinition(patch)),
    async operator(
      userId: string,
      patch: Partial<OperatorProfile> = {},
      status: 'AVAILABLE' | 'AWAY' | 'OFFLINE' = 'AVAILABLE',
    ) {
      await h.service.operators.upsert(profile(userId, patch));
      if (status !== 'OFFLINE') await h.service.operators.heartbeat(userId, status);
    },
    async open(queue: HumanQueue, patch: Partial<NewTicket> = {}): Promise<Ticket> {
      const created = await tickets().create(ticketFor(queue, patch));
      if (created === 'queue_full') throw new Error('queue_full');
      return created;
    },
    accept: (ticket: Pick<Ticket, 'id' | 'version'>, operatorId: string, key = `k-${next()}`) =>
      tickets().accept({
        workspaceId: h.org,
        ticketId: ticket.id,
        operatorId,
        expectedVersion: ticket.version,
        idempotencyKey: key,
      }),
    get: async (id: string) => (await tickets().get(id))!,
    states: async (id: string) =>
      (await h.events(id)).filter((e) => e.kind === 'state').map((e) => e.payload.state),
  };
}
