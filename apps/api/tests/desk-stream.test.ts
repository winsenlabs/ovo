import { afterEach, describe, expect, it } from 'vitest';
import {
  humanQueueApp,
  makeQueue,
  managed,
  onlineOperator,
  openTicket,
  WORKSPACE,
  type HqApp,
} from './human-queue-fixtures.ts';

const apps: HqApp[] = [];
const make = async (options: Parameters<typeof humanQueueApp>[0] = {}) => {
  const built = humanQueueApp(options);
  apps.push(built);
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  return built;
};
afterEach(async () => Promise.all(apps.splice(0).map((hq) => hq.app.close())));

interface Frame {
  id?: string;
  event: string;
  data: unknown;
}

/** Reads server-sent events from a response until `done` says enough, or the time runs out. */
class Stream {
  readonly frames: Frame[] = [];
  private buffer = '';
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private controller = new AbortController();
  status = 0;
  headers!: Headers;

  static async open(hq: HqApp, user: string, headers: Record<string, string> = {}, query = '') {
    const stream = new Stream();
    const address = hq.app.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/desk/stream${query}`, {
      headers: { 'x-user': user, accept: 'text/event-stream', ...headers },
      signal: stream.controller.signal,
    });
    stream.status = response.status;
    stream.headers = response.headers;
    if (response.status === 200) {
      stream.reader = response.body!.getReader();
      void stream.pump();
    } else await response.body?.cancel();
    return stream;
  }

  private async pump() {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) return;
        this.buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = this.buffer.indexOf('\n\n')) >= 0) {
          const block = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 2);
          const lines = block.split('\n');
          const field = (name: string) =>
            lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
          this.frames.push({
            id: field('id'),
            event: field('event')!,
            data: JSON.parse(field('data') ?? 'null'),
          });
        }
      }
    } catch {
      // Closed by the test.
    }
  }

  async until(check: (frames: Frame[]) => boolean, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check(this.frames)) {
      if (Date.now() > deadline)
        throw new Error(
          `stream did not reach the state; saw ${JSON.stringify(this.frames.map((f) => f.event))}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  of(event: string) {
    return this.frames.filter((frame) => frame.event === event);
  }

  close() {
    this.controller.abort();
  }
}

const open = (hq: HqApp, user: string, headers?: Record<string, string>, query?: string) =>
  Stream.open(hq, user, headers, query);

async function floor(hq: HqApp) {
  const queue = await makeQueue(hq, managed({ name: 'Support', teamIds: ['support'] }));
  await onlineOperator(hq, 'asha', { teamIds: ['support'] });
  await onlineOperator(hq, 'meera', { teamIds: ['support'] });
  return queue;
}

describe('GET /v1/desk/stream', () => {
  it('is an event stream that starts with the queue and the operator’s numbers', async () => {
    const hq = await make();
    const queue = await floor(hq);
    const ticket = await openTicket(hq, queue);
    const stream = await open(hq, 'asha');
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      expect(stream.headers.get('cache-control')).toContain('no-cache');
      await stream.until((frames) => frames.some((f) => f.event === 'me'));
      expect(stream.of('ticket').map((f) => (f.data as { id: string }).id)).toEqual([ticket.id]);
      expect(stream.of('ticket')[0]!.data).toMatchObject({
        status: 'waiting',
        callerMasked: '+91••••00',
      });
      expect(stream.of('me')[0]!.data).toMatchObject({
        status: 'AVAILABLE',
        stats: { activeNow: 0 },
      });
      expect(stream.frames.at(-1)!.id).toMatch(/^\d+$/);
    } finally {
      stream.close();
    }
  });

  it('sends a new ticket as it appears and removes it when someone else takes it', async () => {
    const hq = await make();
    const queue = await floor(hq);
    const stream = await open(hq, 'asha');
    try {
      await stream.until((frames) => frames.some((f) => f.event === 'me'));
      const ticket = await openTicket(hq, queue);
      await stream.until((frames) =>
        frames.some((f) => f.event === 'ticket' && (f.data as { id: string }).id === ticket.id),
      );
      await hq.service.tickets.accept({
        workspaceId: WORKSPACE,
        ticketId: ticket.id,
        operatorId: 'meera',
        expectedVersion: ticket.version,
        idempotencyKey: 'k',
      });
      await stream.until((frames) =>
        frames.some((f) => f.event === 'removed' && (f.data as { id: string }).id === ticket.id),
      );
    } finally {
      stream.close();
    }
  });

  it('sends the operator’s own accepted and released tickets as tickets, so the desk can end the call', async () => {
    const hq = await make();
    const queue = await floor(hq);
    const stream = await open(hq, 'asha');
    try {
      await stream.until((frames) => frames.some((f) => f.event === 'me'));
      const ticket = await openTicket(hq, queue);
      await hq.service.tickets.accept({
        workspaceId: WORKSPACE,
        ticketId: ticket.id,
        operatorId: 'asha',
        expectedVersion: ticket.version,
        idempotencyKey: 'k',
      });
      await stream.until((frames) =>
        frames.some(
          (f) => f.event === 'ticket' && (f.data as { status: string }).status === 'accepted',
        ),
      );
      const live = (await hq.service.tickets.get(ticket.id))!;
      await hq.service.tickets.release({
        workspaceId: WORKSPACE,
        ticketId: ticket.id,
        expectedVersion: live.version,
        reason: 'call_ended',
        idempotencyKey: 'r',
        code: 'call_ended',
        by: 'worker',
      });
      await stream.until((frames) =>
        frames.some(
          (f) => f.event === 'ticket' && (f.data as { status: string }).status === 'released',
        ),
      );
    } finally {
      stream.close();
    }
  });

  it('removes a ticket the operator declined, and never shows other teams’ tickets', async () => {
    const hq = await make();
    const queue = await floor(hq);
    const billing = await makeQueue(hq, managed({ name: 'Billing', teamIds: ['billing'] }));
    const stream = await open(hq, 'asha');
    try {
      await stream.until((frames) => frames.some((f) => f.event === 'me'));
      const other = await openTicket(hq, billing);
      const mine = await openTicket(hq, queue);
      await stream.until((frames) =>
        frames.some((f) => f.event === 'ticket' && (f.data as { id: string }).id === mine.id),
      );
      await hq.service.tickets.decline({
        ticketId: mine.id,
        operatorId: 'asha',
        expectedVersion: mine.version,
      });
      await hq.service.tickets.release({
        workspaceId: WORKSPACE,
        ticketId: other.id,
        expectedVersion: other.version,
        reason: 'completed',
        idempotencyKey: 'x',
        code: 'completed',
        by: 'worker',
      });
      const another = await openTicket(hq, queue);
      await stream.until((frames) =>
        frames.some((f) => f.event === 'ticket' && (f.data as { id: string }).id === another.id),
      );
      expect(
        stream.frames.some(
          (f) => f.event === 'ticket' && (f.data as { id: string }).id === other.id,
        ),
      ).toBe(false);
      expect(stream.of('removed').map((f) => (f.data as { id: string }).id)).toContain(mine.id);
    } finally {
      stream.close();
    }
  });

  it('resumes from Last-Event-ID without repeating what the client has', async () => {
    const hq = await make();
    const queue = await floor(hq);
    const first = await open(hq, 'asha');
    await first.until((frames) => frames.some((f) => f.event === 'me'));
    const early = await openTicket(hq, queue);
    await first.until((frames) =>
      frames.some((f) => f.event === 'ticket' && (f.data as { id: string }).id === early.id),
    );
    const cursor = first.frames.at(-1)!.id!;
    first.close();
    const later = await openTicket(hq, queue);
    const resumed = await open(hq, 'asha', { 'last-event-id': cursor });
    try {
      await resumed.until((frames) =>
        frames.some((f) => f.event === 'ticket' && (f.data as { id: string }).id === later.id),
      );
      expect(resumed.of('ticket').map((f) => (f.data as { id: string }).id)).toEqual([later.id]);
      expect(resumed.of('gap')).toEqual([]);
    } finally {
      resumed.close();
    }
  });

  it('accepts the cursor as a query parameter too', async () => {
    const hq = await make();
    const queue = await floor(hq);
    const before = await openTicket(hq, queue);
    const probe = await open(hq, 'asha');
    await probe.until((frames) => frames.some((f) => f.event === 'me'));
    const cursor = probe.frames.at(-1)!.id!;
    probe.close();
    const after = await openTicket(hq, queue);
    const resumed = await open(hq, 'asha', {}, `?cursor=${cursor}`);
    try {
      await resumed.until((frames) => frames.some((f) => f.event === 'ticket'));
      expect(resumed.of('ticket').map((f) => (f.data as { id: string }).id)).toEqual([after.id]);
      void before;
    } finally {
      resumed.close();
    }
  });

  it('says gap, then starts over with a snapshot, when the cursor is from another life', async () => {
    const hq = await make();
    const queue = await floor(hq);
    const ticket = await openTicket(hq, queue);
    const stream = await open(hq, 'asha', { 'last-event-id': '999999' });
    try {
      await stream.until((frames) => frames.some((f) => f.event === 'me'));
      expect(stream.frames[0]!.event).toBe('gap');
      expect(stream.of('ticket').map((f) => (f.data as { id: string }).id)).toEqual([ticket.id]);
    } finally {
      stream.close();
    }
  });

  it('sends a me event when presence changes, and heartbeats with a cursor when quiet', async () => {
    const hq = await make({ sse: { pollMs: 20, heartbeatMs: 50 } });
    await floor(hq);
    const stream = await open(hq, 'asha');
    try {
      await stream.until((frames) => frames.some((f) => f.event === 'heartbeat'));
      expect(stream.of('heartbeat')[0]!.id).toMatch(/^\d+$/);
    } finally {
      stream.close();
    }
  });

  it('caps open streams overall and per operator', async () => {
    const hq = await make({ sse: { maxConnections: 5, pollMs: 20 } });
    await floor(hq);
    const open4 = await Promise.all([1, 2, 3, 4].map(() => open(hq, 'asha')));
    try {
      expect(open4.map((s) => s.status)).toEqual([200, 200, 200, 200]);
      const fifth = await open(hq, 'asha');
      expect(fifth.status).toBe(429);
      const other = await open(hq, 'meera');
      expect(other.status).toBe(200);
      other.close();
      const sixth = await open(hq, 'meera');
      expect(sixth.status).toBe(429);
    } finally {
      for (const stream of open4) stream.close();
    }
  });

  it('frees a slot when a stream closes', async () => {
    const hq = await make({ sse: { maxConnections: 1, pollMs: 20 } });
    await floor(hq);
    const first = await open(hq, 'asha');
    expect((await open(hq, 'meera')).status).toBe(429);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await open(hq, 'meera');
    expect(next.status).toBe(200);
    next.close();
  });

  it('refuses an account that is not an operator, before it becomes a stream', async () => {
    const hq = await make();
    await floor(hq);
    const stream = await open(hq, 'nobody');
    expect(stream.status).toBe(403);
  });

  it('turns an invalid cursor into a 400', async () => {
    const hq = await make();
    await floor(hq);
    expect((await open(hq, 'asha', {}, '?cursor=abc')).status).toBe(400);
  });
});
