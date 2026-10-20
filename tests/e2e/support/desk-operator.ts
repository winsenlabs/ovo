import { expect, vi } from 'vitest';
import type { HumanStack } from './human-setup.ts';
import { operatorApi, signIn, type Operator } from './operator-setup.ts';

const CONSOLE_ADDRESS = '172.29.240.10';

export interface Desk {
  id: string;
  email: string;
  session: Operator;
  /** A desk call that returns the status and the body instead of throwing on a refusal. */
  call(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
  ): Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  presence(status: 'AVAILABLE' | 'AWAY' | 'OFFLINE'): Promise<void>;
  /** The offered tickets of this operator's queues. */
  offered(): Promise<Record<string, any>[]>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * A team member who may answer calls: a user, an enabled operator profile, a signed-in session.
 * `presence('AVAILABLE')` makes them the AUTO_ASSIGN pick when they are the only one online.
 */
export async function addOperator(
  env: HumanStack,
  name: string,
  profile: { teamIds?: string[]; capacity?: number; languages?: string[] } = {},
): Promise<Desk> {
  const admin = operatorApi(env.stack.operator);
  const email = `${name}@operators.example.test`;
  const password = `Operator-${name}-pass-4471-Zq`;
  const user = await admin<{ id: string }>('POST', '/v1/users', {
    email,
    password,
    label: name,
    role: 'editor',
  });
  await admin('PUT', `/v1/human-queues/operators/${user.id}`, {
    displayName: name,
    enabled: true,
    teamIds: profile.teamIds ?? [],
    languages: profile.languages ?? ['en'],
    capacity: profile.capacity ?? 2,
  });
  const session = await signIn(env.stack.operator.app, email, password);
  const call: Desk['call'] = async (method, url, payload) => {
    const response = await session.app.inject({
      method,
      url,
      remoteAddress: CONSOLE_ADDRESS,
      headers: { 'x-forwarded-proto': 'https', cookie: session.cookie },
      ...(payload ? { payload } : {}),
    });
    return { status: response.statusCode, body: response.body ? response.json() : {} };
  };
  return {
    id: user.id,
    email,
    session,
    call,
    async presence(status) {
      const response = await call('PUT', '/v1/desk/presence', { status });
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    },
    async offered() {
      const response = await call('GET', '/v1/desk/tickets?scope=queue');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.items;
    },
  };
}

/** Waits until the operator is offered a ticket (or `count` tickets), and returns them. */
export async function waitOffered(desk: Desk, count = 1) {
  let tickets: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  await vi.waitFor(
    async () => {
      tickets = await desk.offered();
      expect(tickets.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 30_000, interval: 250 },
  );
  return tickets;
}

/** Accepts a ticket the way the desk does: a fresh idempotency key and the ticket's version. */
export function acceptTicket(desk: Desk, ticket: { id: string; version: number }, key?: string) {
  return desk.call('POST', `/v1/desk/tickets/${ticket.id}/accept`, {
    expectedVersion: ticket.version,
    idempotencyKey: key ?? `accept-${ticket.id}-${desk.id}`,
  });
}

/** The desk's event stream, read as text: the snapshot and every change since. */
export async function openStream(desk: Desk) {
  const response = await desk.session.app.inject({
    method: 'GET',
    url: '/v1/desk/stream',
    remoteAddress: CONSOLE_ADDRESS,
    headers: {
      'x-forwarded-proto': 'https',
      cookie: desk.session.cookie,
      accept: 'text/event-stream',
    },
    payloadAsStream: true,
  });
  const stream = response.stream();
  let text = '';
  stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  return {
    text: () => text,
    /** The `event:` names received so far, in order. */
    events: () => [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]!),
    close: () => void stream.destroy(),
  };
}

/** The tickets a stream carried, in order (`ticket` events), as the desk would render them. */
export function streamTickets(stream: Awaited<ReturnType<typeof openStream>>) {
  return [...stream.text().matchAll(/event: ticket\ndata: (.+)\n/g)].map(
    (match) => JSON.parse(match[1]!) as Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  );
}
