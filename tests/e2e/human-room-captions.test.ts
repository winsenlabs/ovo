import { describe, expect, it, vi } from 'vitest';
import { acceptTicket, addOperator, waitOffered } from './support/desk-operator.ts';
import { pressWhenListening } from './support/human-call.ts';
import { joinAsOperator } from './support/room-audio.ts';
import { roomServerBinary, startRoomStack } from './support/room-stack.ts';
import { LINES } from './support/routing-setup.ts';
import { heard, transferCall } from './support/transfer-call.ts';

const net = vi.hoisted(() => ({ routes: new Map<string, string>() }));
vi.mock('../../packages/plugin-kit/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/plugin-kit/src/index.ts')>();
  const { routedNodeNet } = await import('./support/routed-net.ts');
  return { ...actual, createNodeNet: routedNodeNet(actual.createNodeNet, net.routes) };
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
if (!postgresUrl) throw new Error('The human-room-captions test needs OVO_TEST_POSTGRES_URL');

const caption = (data: { topic: string; json: unknown }[]) =>
  data
    .filter((message) => message.topic === 'ovo.caption')
    .map((message) => message.json as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!roomServerBinary())('managed human queue: captions (R3)', () => {
  it('9a. with ai.mode transcribe the operator receives captions of both sides', async () => {
    const room = await startRoomStack(postgresUrl!, net.routes, {});
    try {
      const { env } = room;
      const desk = await addOperator(env, 'asha');
      await desk.presence('AVAILABLE');
      await transferCall(
        env,
        async (call) => {
          await heard(env, call, LINES.greeting);
          await pressWhenListening(env, call, '3');
          const before = env.stt.sessions.length;
          const [ticket] = await waitOffered(desk);
          const accepted = await acceptTicket(desk, ticket as never);
          const operator = await joinAsOperator(accepted.body.room);
          // One silent speech-to-text session per side opens with the human segment: the caller's, then the operator's.
          await vi.waitFor(() => expect(env.stt.sessions.length - before).toBe(2), {
            timeout: 15_000,
          });
          const [callerSide, operatorSide] = env.stt.sessions.slice(before);
          env.stt.sayOn(callerSide!, 'I was double charged in March');
          env.stt.sayOn(operatorSide!, 'Let me look at your account');
          await vi.waitFor(
            () => {
              const lines = caption(operator.data).filter((line) => line.final);
              expect(lines).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    role: 'caller',
                    text: 'I was double charged in March',
                  }),
                  expect.objectContaining({
                    role: 'operator',
                    text: 'Let me look at your account',
                  }),
                ]),
              );
            },
            { timeout: 15_000, interval: 250 },
          );
          // Interim and final lines both arrive, from the caller's seat, in the documented shape.
          const lines = caption(operator.data);
          expect(lines.some((line) => line.final === false)).toBe(true);
          expect(lines.every((line) => Number.isInteger(line.at) && line.at >= 0)).toBe(true);
          expect(operator.data.every((message) => message.from === 'caller')).toBe(true);
          await desk.call('POST', `/v1/desk/tickets/${ticket!.id}/commands`, { kind: 'end_call' });
          await operator.disconnect();
        },
        { carrier: 'hangup' },
      );
    } finally {
      await room.close();
    }
  });

  it('9b. with ai.mode out there are no captions and no speech-to-text session is opened', async () => {
    const room = await startRoomStack(postgresUrl!, net.routes, {
      line: { managed: { ai: { mode: 'out', transcribeOperator: false } } },
    });
    try {
      const { env } = room;
      const desk = await addOperator(env, 'asha');
      await desk.presence('AVAILABLE');
      await transferCall(
        env,
        async (call) => {
          await heard(env, call, LINES.greeting);
          await pressWhenListening(env, call, '3');
          const [ticket] = await waitOffered(desk);
          // The router's own session closes with its segment; count from the moment it has.
          await vi.waitFor(() => expect(env.stt.open()).toEqual([]), { timeout: 15_000 });
          const sessions = env.stt.sessions.length;
          const accepted = await acceptTicket(desk, ticket as never);
          const operator = await joinAsOperator(accepted.body.room);
          await new Promise((resolve) => setTimeout(resolve, 4_000));
          expect(env.stt.sessions.length).toBe(sessions);
          expect(operator.data).toEqual([]);
          await desk.call('POST', `/v1/desk/tickets/${ticket!.id}/commands`, { kind: 'end_call' });
          await operator.disconnect();
        },
        { carrier: 'hangup' },
      );
    } finally {
      await room.close();
    }
  });
});
