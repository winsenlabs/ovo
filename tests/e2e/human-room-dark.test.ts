import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { humanStack, type HumanStack } from './support/human-setup.ts';
import { at, of, pressWhenListening } from './support/human-call.ts';
import { LIVEKIT_DEFAULT_PORTS, listeningSockets } from './support/listen-scan.ts';
import { operatorApi } from './support/operator-setup.ts';
import { LINES } from './support/routing-setup.ts';
import { heard, transferCall } from './support/transfer-call.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error('The human-room-dark test needs OVO_TEST_POSTGRES_URL');

describe('managed human queue with the room feature dark (R3)', () => {
  let env: HumanStack;
  /** The listening sockets of an installation with the human queue feature entirely off. */
  let baseline: ReturnType<typeof listeningSockets>;
  beforeAll(async () => {
    const off = await humanStack(postgresUrl!, net.routes, {
      humanQueue: false,
      line: { managed: false, external: false },
    });
    baseline = listeningSockets();
    await off.close();
    // Queues are on, a managed queue is configured and bound, but OVO_LIVEKIT_ENABLED is unset.
    env = await humanStack(postgresUrl!, net.routes, { line: { managed: true, external: false } });
  }, 180_000);
  afterAll(async () => env?.close());

  it('10. no media-room capability: the queue refuses queue_unavailable, the status says so, nothing new listens', async () => {
    const status = await operatorApi(env.stack.operator)<
      Record<string, any>
    > // eslint-disable-line @typescript-eslint/no-explicit-any
    ('GET', '/v1/human-queues/status');
    expect(status).toMatchObject({
      enabled: true,
      managedAvailable: false,
      room: { configured: false },
    });
    expect(env.stack.variables.OVO_LIVEKIT_ENABLED ?? 'false').not.toBe('true');

    const spoken = env.openAi.speech.length;
    const result = await transferCall(env, async (call) => {
      await heard(env, call, LINES.greeting);
      await pressWhenListening(env, call, '3');
      await heard(env, call, LINES.fallback);
    });
    const { events } = result;
    at(events, 'human.requested', {
      kind: 'managed',
      result: 'refused',
      refusal: 'queue_unavailable',
    });
    expect(of(events, 'human.state')).toEqual([]);
    at(events, 'route.fallback', { step: 'default', result: 'taken' });
    // No ticket, no room, nothing announced to the caller.
    expect((await env.stack.db.query('SELECT 1 FROM ovo_hq_tickets')).rowCount).toBe(0);
    expect(env.openAi.speech.slice(spoken).join(' ')).not.toContain('Connecting you to our team');

    // Nothing in this installation listens beyond what it did with the feature off: the same
    // TCP listeners, no UDP socket at all, none on a LiveKit default port, and at most the one wildcard
    // listener the worker's health server has always been.
    const sockets = listeningSockets();
    expect(sockets.filter((socket) => socket.protocol === 'udp')).toEqual([]);
    expect(sockets).toHaveLength(baseline.length);
    expect(sockets.filter((socket) => socket.host === '*')).toHaveLength(
      baseline.filter((socket) => socket.host === '*').length,
    );
    for (const { port } of sockets) {
      expect(LIVEKIT_DEFAULT_PORTS, `port ${port}`).not.toContain(port);
    }
  });
});
