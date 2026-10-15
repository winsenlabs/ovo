// The operator desk and human queue fixture API (Wave 17), served by e2e/auth-server.mjs beside
// the session check. The scenario comes from the `ovo_fixture` cookie: `rich` (a busy floor),
// `empty` (nothing waiting, no queues, no operators), `down` (every GET answers 503) and
// `disabled` (the feature is switched off: 404 `human_queue_disabled`). The room provider is the
// console's deterministic `fake` client, so no media server is involved, unless
// `OVO_E2E_ROOM_GRANT_FILE` names a file holding a real room grant (desk-room.spec.ts writes one):
// then `me`, the status and every accept answer with that grant and the desk joins that server.
import { readFileSync } from 'node:fs';

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};

const FAKE_ROOM = { provider: 'fake', serverUrl: 'wss://rooms.fixture.test' };
const realGrant = () => {
  try {
    return JSON.parse(readFileSync(process.env.OVO_E2E_ROOM_GRANT_FILE ?? '', 'utf8'));
  } catch {
    return undefined;
  }
};
const roomOf = () => {
  const real = realGrant();
  return real ? { provider: real.provider, serverUrl: real.serverUrl } : FAKE_ROOM;
};
const state = { status: 'AVAILABLE' };

const waiting = (id, patch) => ({
  id,
  queueId: 'q-support',
  queueKey: 'support',
  queueName: 'Support desk',
  kind: 'managed',
  mode: 'OPEN_PICKUP',
  status: 'waiting',
  version: 1,
  priority: 0,
  language: 'en',
  callerMasked: '+91••••4321',
  offeredToMe: false,
  ...patch,
});

function tickets(scenario) {
  if (scenario === 'empty') return [];
  const t = now();
  const at = (secondsAgo) => ({ createdAt: iso(t - secondsAgo * 1000), waitMs: secondsAgo * 1000 });
  return [
    waiting('t-1', { ...at(184), callerMasked: '+91••••4321', language: 'hi', priority: 2 }),
    waiting('t-2', { ...at(95), callerMasked: '+91••••8830' }),
    waiting('t-3', {
      ...at(41),
      queueId: 'q-billing',
      queueName: 'Billing desk',
      queueKey: 'billing',
      mode: 'AUTO_ASSIGN',
      status: 'offered',
      offeredToMe: true,
      offerExpiresAt: iso(t + 14_000),
      callerMasked: '+91••••1207',
    }),
    waiting('t-4', { ...at(12), callerMasked: '+91••••5592', language: 'ta' }),
  ];
}

const me = (scenario) => ({
  profile: {
    userId: 'fixture-admin',
    displayName: 'Asha Menon',
    enabled: true,
    teamIds: ['support', 'billing'],
    languages: ['en', 'hi'],
    capacity: 1,
  },
  status: state.status,
  queues:
    scenario === 'empty'
      ? []
      : [
          {
            id: 'q-support',
            name: 'Support desk',
            assignment: 'OPEN_PICKUP',
            returnTargets: [{ key: 'billing-bot', label: 'Billing assistant' }],
            wrapUp: {
              required: false,
              dispositions: ['Resolved', 'Escalated', 'Callback promised'],
            },
          },
          {
            id: 'q-billing',
            name: 'Billing desk',
            assignment: 'AUTO_ASSIGN',
            returnTargets: [],
            wrapUp: { required: true, dispositions: ['Refunded', 'Disputed'] },
          },
        ],
  roomProvider: roomOf(),
  presenceTtlSeconds: 30,
  stats: {
    handledToday: scenario === 'empty' ? 0 : 23,
    activeNow: 0,
    onlineOperators: scenario === 'empty' ? 1 : 4,
  },
});

const context = {
  callId: 'call-fixture-8d41c7a2',
  brief: 'Language: Hindi. Intent: billing. Asked for: a person.',
  summary:
    'The caller was charged twice for the October instalment and wants a refund of the duplicate.',
  reason: 'wants a person',
  language: 'hi',
  intent: 'billing',
  routePath: ['intent', 'billing'],
  caller: { number: '+919800004321', calledNumber: '+918040000001' },
  transcript: [
    { role: 'agent', text: 'Namaste, you have reached Sunrise Finance. How can I help?' },
    { role: 'caller', text: 'Meri instalment do baar kat gayi hai.' },
    {
      role: 'agent',
      text: 'I am sorry about that. I will connect you to a colleague who can fix it.',
    },
  ],
  variables: { account_id: 'SF-100482', amount_due: '12,450' },
  returnTargets: [{ key: 'billing-bot', label: 'Billing assistant' }],
};

const queueRecord = (id, definition, stats = {}) => ({
  id,
  workspaceId: 'fixture-workspace',
  version: 3,
  definition,
  stats: { waiting: 2, offered: 0, oldestWaitMs: 95_000, online: 3, handled24h: 41, ...stats },
  usedBy: ['point-1'],
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z',
});
const managed = (name, patch = {}) => ({
  kind: 'managed',
  name,
  limits: { maxWaiting: 100 },
  assignment: 'OPEN_PICKUP',
  teamIds: ['support'],
  language: 'prefer',
  offerSeconds: 20,
  joinSeconds: 25,
  requireOnline: true,
  ai: { mode: 'transcribe', transcribeOperator: true },
  onOperatorLeave: 'end_call',
  returnTargets: ['billing-bot'],
  wrapUp: { required: false, dispositions: ['Resolved', 'Escalated'] },
  context: {
    callerId: true,
    calledNumber: true,
    language: true,
    intent: true,
    summary: true,
    transcriptTurns: 6,
    transcriptLink: false,
    variables: 'declared',
    summarize: 'agent_only',
  },
  ...patch,
});
const external = {
  kind: 'external',
  name: 'Acme call centre',
  limits: { maxWaiting: 50 },
  webhook: {
    url: 'https://acd.acme.example/ovo/handoff',
    method: 'POST',
    format: 'json',
    credentialId: 'cred-acd',
    auth: { kind: 'none' },
    headers: { 'X-Region': 'in' },
    body: { callId: { $from: 'call.id' }, language: { $from: 'route.language', default: 'en' } },
    timeoutMs: 3000,
    retry: { attempts: 3, baseMs: 500, maxMs: 5000, deadlineMs: 15000 },
    response: {
      acceptedValues: ['accepted'],
      queuedValues: ['queued'],
      rejectedValues: ['rejected'],
      statusPath: '/result',
      destinationE164Path: '/dial/number',
    },
    cancel: true,
  },
  destination: {
    allowE164Prefixes: ['+9140', '+91801'],
    allowSipHosts: ['.acd.acme.example'],
    allowInsecureSip: false,
    allowedHeaders: ['X-Acd-Ticket'],
  },
  context: {
    callerId: false,
    calledNumber: false,
    language: true,
    intent: true,
    summary: true,
    transcriptTurns: 0,
    transcriptLink: true,
    variables: ['account_id'],
    summarize: 'agent_only',
  },
  callbackWindowHours: 24,
};

const queues = (scenario) =>
  scenario === 'empty'
    ? []
    : [
        queueRecord('q-support', managed('Support desk')),
        queueRecord(
          'q-billing',
          managed('Billing desk', {
            assignment: 'AUTO_ASSIGN',
            teamIds: ['billing'],
            returnTargets: [],
          }),
          { waiting: 0, online: 1, oldestWaitMs: 0 },
        ),
        queueRecord('q-acd', external, { waiting: 0, online: 0, oldestWaitMs: 0, handled24h: 18 }),
      ];

const operators = (scenario) =>
  scenario === 'empty'
    ? []
    : [
        {
          userId: 'fixture-admin',
          label: 'Asha Menon',
          email: 'asha@sunrise.example',
          userDisabled: false,
          displayName: 'Asha Menon',
          enabled: true,
          teamIds: ['support', 'billing'],
          languages: ['en', 'hi'],
          capacity: 1,
          status: 'AVAILABLE',
          lastSeenAt: iso(now() - 4_000),
          active: 0,
        },
        {
          userId: 'u-ravi',
          label: 'Ravi Shah',
          email: 'ravi@sunrise.example',
          userDisabled: false,
          displayName: 'Ravi Shah',
          enabled: true,
          teamIds: ['support'],
          languages: ['en', 'gu'],
          capacity: 2,
          status: 'AWAY',
          lastSeenAt: iso(now() - 40_000),
          active: 1,
        },
        {
          userId: 'u-meera',
          label: 'Meera Iyer',
          email: 'meera@sunrise.example',
          userDisabled: false,
          displayName: 'Meera Iyer',
          enabled: false,
          teamIds: ['billing'],
          languages: ['ta', 'en'],
          capacity: 1,
          status: 'OFFLINE',
          active: 0,
        },
      ];

/** One SSE connection: the snapshot, then a heartbeat that keeps it open. */
function stream(request, response, scenario) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const frames = [...tickets(scenario).map((t) => `event: ticket\ndata: ${JSON.stringify(t)}\n\n`)];
  const m = me(scenario);
  frames.push(
    `id: 1\nevent: me\ndata: ${JSON.stringify({ status: m.status, stats: m.stats })}\n\n`,
  );
  response.write(frames.join(''));
  const timer = setInterval(() => response.write('id: 1\nevent: heartbeat\ndata: {}\n\n'), 5_000);
  request.on('close', () => clearInterval(timer));
}

const readBody = (request) =>
  new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text ? JSON.parse(text) : {}));
  });

/** Answers a `/v1/desk/*` or `/v1/human-queues/*` request; false when the path is not ours. */
export async function handleDeskApi(request, response, scenario) {
  const url = new URL(request.url, 'http://fixture');
  const path = url.pathname;
  const ours = /^\/v1\/(desk|human-queues|users|credentials|routing\/audio)(\/|$)/.test(path);
  if (!ours) return false;
  if (scenario === 'disabled' && path !== '/v1/human-queues/status')
    return (
      json(response, 404, {
        error: { code: 'human_queue_disabled', message: 'Human queues are not enabled' },
      }),
      true
    );
  if (scenario === 'down' && request.method === 'GET')
    return (
      json(response, 503, { error: { code: 'unavailable', message: 'Fixture is down' } }),
      true
    );
  const method = request.method;
  if (path === '/v1/human-queues/status')
    return (
      json(response, 200, {
        enabled: scenario !== 'disabled',
        webhookEnabled: true,
        managedAvailable: true,
        room: {
          configured: true,
          provider: roomOf().provider,
          publicUrl: roomOf().serverUrl,
          reachable: true,
        },
      }),
      true
    );
  if (path === '/v1/desk/me') return (json(response, 200, me(scenario)), true);
  if (path === '/v1/desk/stream') return (stream(request, response, scenario), true);
  if (path === '/v1/desk/tickets' && method === 'GET') {
    const mine = url.searchParams.get('scope') === 'mine';
    return (json(response, 200, { items: mine ? [] : tickets(scenario) }), true);
  }
  if (path === '/v1/desk/presence' && method === 'PUT') {
    state.status = (await readBody(request)).status;
    return (json(response, 200, { status: state.status }), true);
  }
  if (path === '/v1/desk/heartbeat') return (json(response, 200, { status: state.status }), true);
  const ticket =
    /^\/v1\/desk\/tickets\/([^/]+)\/(accept|decline|token|context|commands|wrap-up|release)$/.exec(
      path,
    );
  if (ticket) {
    const [, id, action] = ticket;
    const view = {
      ...(tickets('rich').find((t) => t.id === id) ?? waiting(id, {})),
      status: 'accepted',
      version: 2,
      assignedOperatorId: 'fixture-admin',
      connectedAt: iso(now()),
    };
    const grant = realGrant() ?? {
      ...FAKE_ROOM,
      roomName: `ovo-hq-${id}`,
      identity: 'op:fixture-admin',
      role: 'operator',
      token: 'fixture-token',
      expiresAt: iso(now() + 120_000),
    };
    if (action === 'accept')
      return (json(response, 200, { ticket: view, room: grant, context }), true);
    if (action === 'token') return (json(response, 200, { room: grant }), true);
    if (action === 'context') return (json(response, 200, context), true);
    if (action === 'commands') return (json(response, 202, { seq: 1 }), true);
    return (json(response, action === 'release' ? 202 : 204, {}), true);
  }
  if (path === '/v1/human-queues' && method === 'GET')
    return (json(response, 200, { items: queues(scenario), nextCursor: null }), true);
  if (path === '/v1/human-queues/operators' && method === 'GET')
    return (json(response, 200, { items: operators(scenario) }), true);
  if (path === '/v1/human-queues/preview')
    return (
      json(response, 200, { body: { callId: 'call-test', language: 'en' }, issues: [] }),
      true
    );
  if (/^\/v1\/human-queues\/[^/]+\/test-webhook$/.test(path))
    return (
      json(response, 200, {
        request: {
          url: 'https://acd.acme.example/ovo/handoff',
          headers: { 'x-ovo-signature': 'v1=<computed per attempt>' },
          body: { callId: 'call-test' },
        },
        attempts: [
          { attempt: 1, outcome: 'retry', status: 503, ms: 210, reason: 'http_503' },
          { attempt: 2, outcome: 'delivered', status: 200, ms: 96 },
        ],
        answer: {
          kind: 'accepted',
          destination: { e164: '+9140123456' },
          destinationCheck: 'allowed',
        },
      }),
      true
    );
  if (path === '/v1/users')
    return (
      json(response, 200, {
        items: [{ id: 'u-new', email: 'new@sunrise.example', label: 'Nisha Rao', disabled: false }],
      }),
      true
    );
  if (path === '/v1/credentials')
    return (
      json(response, 200, {
        items: [
          { id: 'cred-acd', label: 'Acme signing secret' },
          { id: 'cred-key', label: 'Acme API key' },
        ],
      }),
      true
    );
  if (path === '/v1/routing/audio')
    return (json(response, 200, { items: [{ id: 'clip-1', name: 'Hold music' }] }), true);
  if (method === 'GET') return (json(response, 200, { items: [] }), true);
  return (json(response, 204, {}), true);
}
