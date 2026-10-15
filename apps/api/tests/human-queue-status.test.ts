import { afterEach, describe, expect, it } from 'vitest';
import { humanQueueFlagsFromEnv } from '../src/human-queue-config.ts';
import { humanQueueApp, managed, type HqApp } from './human-queue-fixtures.ts';

const apps: HqApp[] = [];
const make = (options: Parameters<typeof humanQueueApp>[0] = {}) => {
  const built = humanQueueApp(options);
  apps.push(built);
  return built;
};
afterEach(async () => Promise.all(apps.splice(0).map((hq) => hq.app.close())));

describe('humanQueueFlagsFromEnv', () => {
  it('is off unless the flag is exactly true', () => {
    expect(humanQueueFlagsFromEnv({}).humanQueueEnabled).toBe(false);
    for (const value of ['TRUE', '1', 'yes', ' true'])
      expect(humanQueueFlagsFromEnv({ OVO_HUMAN_QUEUE_ENABLED: value }).humanQueueEnabled).toBe(
        false,
      );
    expect(humanQueueFlagsFromEnv({ OVO_HUMAN_QUEUE_ENABLED: 'true' }).humanQueueEnabled).toBe(
      true,
    );
    expect(
      humanQueueFlagsFromEnv({ OVO_HUMAN_QUEUE_WEBHOOK_ENABLED: 'true' }).humanQueueWebhookEnabled,
    ).toBe(true);
    expect(humanQueueFlagsFromEnv({}).humanQueueWebhookEnabled).toBe(false);
  });

  it('keeps the room token TTL and the presence TTL inside their documented bounds', () => {
    expect(humanQueueFlagsFromEnv({}).roomTokenTtlSeconds).toBe(120);
    expect(
      humanQueueFlagsFromEnv({ OVO_LIVEKIT_TOKEN_TTL_SECONDS: '45' }).roomTokenTtlSeconds,
    ).toBe(45);
    for (const bad of ['5', '601', 'abc', '', '1.5'])
      expect(
        humanQueueFlagsFromEnv({ OVO_LIVEKIT_TOKEN_TTL_SECONDS: bad }).roomTokenTtlSeconds,
      ).toBe(120);
    expect(humanQueueFlagsFromEnv({}).humanQueuePresenceTtlSeconds).toBe(30);
    expect(
      humanQueueFlagsFromEnv({ OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS: '60' })
        .humanQueuePresenceTtlSeconds,
    ).toBe(60);
    expect(
      humanQueueFlagsFromEnv({ OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS: '5' })
        .humanQueuePresenceTtlSeconds,
    ).toBe(30);
  });

  it('takes the callback origin from its own variable, else the media origin', () => {
    expect(humanQueueFlagsFromEnv({}).humanQueueCallbackBaseUrl).toBeUndefined();
    expect(
      humanQueueFlagsFromEnv({ OVO_MEDIA_PUBLIC_BASE_URL: 'https://media.example' })
        .humanQueueCallbackBaseUrl,
    ).toBe('https://media.example');
    expect(
      humanQueueFlagsFromEnv({
        OVO_MEDIA_PUBLIC_BASE_URL: 'https://media.example',
        OVO_HUMAN_QUEUE_CALLBACK_BASE_URL: 'https://hooks.example',
      }).humanQueueCallbackBaseUrl,
    ).toBe('https://hooks.example');
  });
});

describe('GET /v1/human-queues/status', () => {
  it('reports a fully available installation with a reachable room', async () => {
    const hq = make();
    const response = await hq.call('GET', '/v1/human-queues/status', { role: 'viewer' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      webhookEnabled: true,
      managedAvailable: true,
      room: {
        configured: true,
        provider: 'fake-room',
        publicUrl: 'wss://rooms.fake.test',
        reachable: true,
      },
    });
  });

  it('says the room is unreachable, then recovers once the 30 s cache lapses', async () => {
    const hq = make();
    hq.rooms!.setHealthy(false);
    const down = (await hq.call('GET', '/v1/human-queues/status')).json();
    expect([down.managedAvailable, down.room.reachable]).toEqual([false, false]);
    hq.rooms!.setHealthy(true);
    const cached = (await hq.call('GET', '/v1/human-queues/status')).json();
    expect(cached.room.reachable).toBe(false);
    hq.service.clock.advance(31_000);
    const fresh = (await hq.call('GET', '/v1/human-queues/status')).json();
    expect([fresh.managedAvailable, fresh.room.reachable]).toEqual([true, true]);
  });

  it('says so when no room server is composed', async () => {
    const hq = make({ noRooms: true });
    const body = (await hq.call('GET', '/v1/human-queues/status')).json();
    expect(body.room).toEqual({ configured: false });
    expect(body.managedAvailable).toBe(false);
  });

  it('keeps answering while the feature is off, and says it is off', async () => {
    const hq = make({ enabled: false, webhookEnabled: true });
    const response = await hq.call('GET', '/v1/human-queues/status');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: false,
      webhookEnabled: false,
      managedAvailable: false,
    });
  });

  it('reports the sweeper’s last run when the service knows it', async () => {
    const hq = make();
    (hq.service as unknown as { lastSweep: () => Promise<string> }).lastSweep = async () =>
      '2026-10-15T09:00:00.000Z';
    expect((await hq.call('GET', '/v1/human-queues/status')).json().sweeper).toEqual({
      lastRunAt: '2026-10-15T09:00:00.000Z',
    });
  });

  it('needs a signed-in viewer', async () => {
    const hq = make();
    expect(
      (await hq.call('GET', '/v1/human-queues/status', { headers: { 'x-anonymous': '1' } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('the dark switch', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/v1/human-queues'],
    ['POST', '/v1/human-queues', { definition: managed() }],
    ['GET', '/v1/human-queues/00000000-0000-4000-8000-000000000001'],
    ['GET', '/v1/human-queues/operators'],
    ['POST', '/v1/human-queues/preview', { spec: {}, policy: {} }],
    ['GET', '/v1/desk/me'],
    ['GET', '/v1/desk/tickets'],
    ['PUT', '/v1/desk/presence', { status: 'AVAILABLE' }],
    ['POST', '/v1/desk/heartbeat', {}],
    ['GET', '/v1/desk/stream'],
    ['POST', '/v1/human-queue/callbacks/00000000-0000-4000-8000-000000000001', {}],
    ['GET', '/v1/human-queue/context/00000000-0000-4000-8000-000000000001?t=aaaaaaaaaaaaaaaaaaaa'],
  ];

  it.each(routes)(
    'answers 404 human_queue_disabled for %s %s while the flag is off',
    async (method, url, payload) => {
      const hq = make({ enabled: false });
      const response = await hq.call(method as 'GET', url, { payload });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('human_queue_disabled');
    },
  );

  it('also says 404 when there is no PostgreSQL operations service', async () => {
    const hq = make({ noOperations: true });
    const response = await hq.call('GET', '/v1/human-queues');
    expect([response.statusCode, response.json().error.code]).toEqual([
      404,
      'human_queue_disabled',
    ]);
    expect((await hq.call('GET', '/v1/human-queues/status')).json().enabled).toBe(false);
  });

  it('never leaks that a queue exists to a role that may not read the list', async () => {
    const hq = make();
    expect((await hq.call('GET', '/v1/human-queues', { role: 'viewer' })).statusCode).toBe(200);
  });
});
