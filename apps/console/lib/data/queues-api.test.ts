import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queuesApi } from './queues-api';
import { deskApi } from './desk-api';
import { blankQueue } from '../derive/queues';

const request = vi.hoisted(() => vi.fn());
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  apiRequest: request,
}));

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ data: { items: [] } });
});

const lastCall = () => request.mock.calls.at(-1) as [string, RequestInit | undefined];

describe('queuesApi', () => {
  it('sends If-Match with the row version on update and delete', async () => {
    const definition = blankQueue('managed');
    await queuesApi.update('q 1', definition, 7);
    let [path, init] = lastCall();
    expect(path).toBe('/human-queues/q%201');
    expect(init).toMatchObject({ method: 'PUT', headers: { 'if-match': '"7"' } });
    expect(JSON.parse(init!.body as string)).toEqual({ definition });
    await queuesApi.remove('q1', 3);
    [path, init] = lastCall();
    expect(init).toMatchObject({ method: 'DELETE', headers: { 'if-match': '"3"' } });
    expect(init!.body).toBeUndefined();
  });

  it('creates with the definition in an envelope', async () => {
    const definition = blankQueue('external');
    await queuesApi.create(definition);
    const [path, init] = lastCall();
    expect([path, init?.method]).toEqual(['/human-queues', 'POST']);
    expect(JSON.parse(init!.body as string)).toEqual({ definition });
  });

  it('reads the list as items, whatever the envelope', async () => {
    request.mockResolvedValueOnce({ data: { items: [{ id: 'a' }], nextCursor: null } });
    expect(await queuesApi.list()).toEqual([{ id: 'a' }]);
    request.mockResolvedValueOnce({ data: [{ id: 'b' }] });
    expect(await queuesApi.list()).toEqual([{ id: 'b' }]);
  });

  it('previews and tests on the paths the API serves', async () => {
    await queuesApi.preview({ body: {} }, { callerId: false });
    expect(lastCall()[0]).toBe('/human-queues/preview');
    expect(JSON.parse(lastCall()[1]!.body as string)).toEqual({ spec: { body: {} }, policy: { callerId: false } });
    await queuesApi.testWebhook('q9');
    expect([lastCall()[0], lastCall()[1]?.method]).toEqual(['/human-queues/q9/test-webhook', 'POST']);
  });

  it('writes only the profile fields of an operator, never presence or directory details', async () => {
    await queuesApi.saveOperator('u1', {
      userId: 'u1',
      label: 'Asha',
      email: 'asha@example.test',
      userDisabled: false,
      displayName: 'Asha K',
      enabled: true,
      teamIds: ['support'],
      languages: ['en'],
      capacity: 2,
      lastSeenAt: '2026-10-15T10:00:00.000Z',
    });
    const [path, init] = lastCall();
    expect([path, init?.method]).toEqual(['/human-queues/operators/u1', 'PUT']);
    expect(JSON.parse(init!.body as string)).toEqual({
      userId: 'u1',
      displayName: 'Asha K',
      enabled: true,
      teamIds: ['support'],
      languages: ['en'],
      capacity: 2,
    });
  });
});

describe('deskApi', () => {
  it('calls the desk paths with the methods and bodies the API expects', async () => {
    await deskApi.setPresence('AWAY');
    expect(lastCall()).toEqual(['/desk/presence', expect.objectContaining({ method: 'PUT', body: '{"status":"AWAY"}' })]);
    await deskApi.accept('t 1', 4, 'key-1');
    expect(lastCall()[0]).toBe('/desk/tickets/t%201/accept');
    expect(JSON.parse(lastCall()[1]!.body as string)).toEqual({ expectedVersion: 4, idempotencyKey: 'key-1' });
    await deskApi.decline('t1', 4);
    expect(JSON.parse(lastCall()[1]!.body as string)).toEqual({ expectedVersion: 4 });
    await deskApi.command('t1', { kind: 'return_to_agent', target: 'bot' });
    expect(JSON.parse(lastCall()[1]!.body as string)).toEqual({ kind: 'return_to_agent', target: 'bot' });
    await deskApi.wrapUp('t1', { disposition: 'Resolved' });
    expect([lastCall()[0], lastCall()[1]?.method]).toEqual(['/desk/tickets/t1/wrap-up', 'PUT']);
    await deskApi.heartbeat();
    expect([lastCall()[0], lastCall()[1]?.method]).toEqual(['/desk/heartbeat', 'POST']);
  });

  it('reads tickets by scope and unwraps a re-minted grant', async () => {
    request.mockResolvedValueOnce({ data: { items: [{ id: 't1' }] } });
    expect(await deskApi.tickets('mine')).toEqual([{ id: 't1' }]);
    expect(lastCall()[0]).toBe('/desk/tickets?scope=mine');
    request.mockResolvedValueOnce({ data: { room: { token: 'jwt' } } });
    expect(await deskApi.token('t1')).toEqual({ token: 'jwt' });
  });
});
