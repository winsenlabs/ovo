// The call visibility fixture API (Wave 18), served by e2e/auth-server.mjs beside the session check:
// the Calls list and call inspector (`/v1/calls*`), the agents behind them, and the routing eval
// runs of the Evaluations screen (`/v1/routing/eval-runs`). Everything is deterministic.
//
// The scenario is the `ovo_fixture` cookie: `rich` (routed calls, runs), `empty` (no calls, no runs),
// `down` (every GET answers 503) and `disabled` (routing is switched off: the status says so and
// `/v1/routing/*` answers 404 `routing_disabled`). Which kind of call the inspector opens is the
// call id: `call-routed-1` (router, sales, billing, a person; one transfer refused), `call-direct-1`
// (never routed), `call-unavailable-1` (outcomes are not stored), `call-segdown-1` (the segments
// endpoint fails) and `call-live-1` (still running). `ovo_inspector=nooutcomes` makes the Calls
// list say its routing filters cannot be applied.
//
// Paths the routing lane also serves (`/v1/agents`, `/v1/plugins`, `/v1/routing/status`, `/v1/routing/points*`)
// are answered here only when the `ovo_inspector` cookie is present, so its own specs are untouched.

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const readBody = (request) =>
  new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text ? JSON.parse(text) : {}));
  });

const START = Date.parse('2026-10-20T10:00:00.000Z');
const at = (seconds) => new Date(START + seconds * 1000).toISOString();

const AGENTS = [
  { id: 'agent-router', name: 'Front desk', release: 'rel-router-1' },
  { id: 'agent-sales', name: 'Sales agent', release: 'rel-sales-0001' },
  { id: 'agent-billing', name: 'Billing agent', release: 'rel-billing-0001' },
];
const POINTS = [
  { id: 'point-1', draft: { name: 'Main line' } },
  { id: 'point-2', draft: { name: 'Collections line' } },
];

const cost = (paise) => ({
  currency: 'INR',
  estimatedPaise: String(paise),
  reconciledPaise: '0',
  totalPaise: String(paise),
});
const segment = (
  index,
  role,
  agentId,
  releaseId,
  reason,
  startedSeconds,
  durationMs,
  extra = {},
) => ({
  index,
  role,
  agentId,
  releaseId,
  reason,
  poolId: null,
  memberId: null,
  language: 'hi',
  transfer: null,
  startedAt: at(startedSeconds),
  durationMs,
  ended: 'handoff',
  cost: null,
  ...extra,
});

let sequence = 0;
const event = (type, payload, seconds, extra = {}) => ({
  sequence: ++sequence,
  at: at(seconds),
  type,
  payload,
  ...extra,
});

function routedSegments() {
  sequence = 0;
  return {
    callId: 'call-routed-1',
    available: true,
    route: {
      routingPointId: 'point-1',
      routingReleaseId: 'rel-1',
      path: ['language', 'intent'],
      target: 'agent',
      agentId: 'agent-sales',
      releaseId: 'rel-sales-0001',
      poolId: 'pool-sales',
      memberId: 'sales-hi',
      language: 'hi',
      degraded: null,
      segments: 4,
      turns: 3,
      routeMs: 7400,
      fallbacks: 1,
      reasks: 1,
    },
    segments: [
      segment(0, 'router', 'agent-router', 'rel-router-1', 'start', 0, 8000, { cost: cost(120) }),
      segment(1, 'agent', 'agent-sales', 'rel-sales-0001', 'route', 8, 62000, {
        poolId: 'pool-sales',
        memberId: 'sales-hi',
        cost: cost(840),
      }),
      segment(2, 'agent', 'agent-billing', 'rel-billing-0001', 'transfer', 74.2, 40000, {
        language: 'en',
        transfer: 1,
        cost: cost(510),
      }),
      segment(3, 'human', 'queue:desk', 'q-desk', 'transfer', 135.2, 44800, {
        transfer: 2,
        ended: 'call_end',
      }),
    ],
    human: {
      queue: 'desk',
      queueId: 'q-desk',
      kind: 'managed',
      ticket: 'ticket-9',
      waitMs: 19000,
      talkMs: 44800,
      operator: 'u-asha',
      outcome: 'connected',
    },
    transfers: [
      {
        requested: {
          transfer: 1,
          fromSegment: 1,
          source: 'llm',
          kind: 'agent',
          key: 'vip',
          result: 'refused',
          refusal: 'no_eligible_member',
        },
        completed: null,
      },
      {
        requested: {
          transfer: 1,
          fromSegment: 1,
          source: 'llm',
          kind: 'agent',
          key: 'billing',
          confirm: 'asked',
          result: 'accepted',
        },
        completed: {
          transfer: 1,
          outcome: 'connected',
          toSegment: 2,
          holdMs: 4200,
          prepareMs: 800,
          queueMs: 0,
          gapMs: 300,
          holdPolicy: 'target',
          steps: [],
        },
      },
      {
        requested: {
          transfer: 2,
          fromSegment: 2,
          source: 'llm',
          kind: 'human',
          key: 'desk',
          result: 'accepted',
          queued: true,
        },
        completed: {
          transfer: 2,
          outcome: 'connected',
          toSegment: 3,
          holdMs: 21000,
          queueMs: 19000,
          holdPolicy: 'queue',
          steps: [{ step: 'target', result: 'taken' }],
        },
      },
    ],
    callLevelCost: cost(60),
    events: [
      event(
        'route.node',
        {
          turn: 1,
          node: 'language',
          engine: 'rules',
          outcome: 'matched',
          branch: 'hi',
          confidence: 1,
          ms: 2,
        },
        3,
      ),
      event(
        'route.node',
        {
          turn: 2,
          node: 'intent',
          engine: 'llm',
          outcome: 'low_confidence',
          confidence: 0.42,
          ms: 380,
        },
        5,
      ),
      event(
        'route.fallback',
        { turn: 2, node: 'intent', step: 'reask', result: 'taken', attempt: 1 },
        5.1,
      ),
      event(
        'route.node',
        {
          turn: 3,
          node: 'intent',
          engine: 'llm',
          outcome: 'matched',
          branch: 'sales',
          confidence: 0.91,
          ms: 410,
        },
        7,
      ),
      event('disclosure', { kinds: ['ai', 'recording'], segment: 0 }, 1),
      event('disclosure', { kinds: ['identity'], segment: 2 }, 76, { segment: 2 }),
      event(
        'segment.ended',
        { index: 0, turns: 3, durationMs: 8000, usage: { 'stt.seconds': 8 } },
        8,
      ),
      event(
        'segment.ended',
        { index: 1, turns: 9, durationMs: 62000, endReason: 'handoff:billing' },
        70,
      ),
      event(
        'human.state',
        { ticket: 'ticket-9', state: 'connected', by: 'operator', callback: 'accepted' },
        150,
      ),
    ],
    eventsTruncated: false,
  };
}
const NO_ROUTE = {
  available: true,
  route: null,
  segments: [],
  human: null,
  transfers: [],
  callLevelCost: null,
  events: [],
};

const line = (id, speaker, text, atMs, segmentIndex) => ({
  id,
  speaker,
  phase: speaker === 'User' ? 'final' : 'played',
  text,
  atMs,
  ...(segmentIndex === undefined ? {} : { segment: segmentIndex }),
});

const CALLS = {
  'call-routed-1': {
    agentId: 'agent-router',
    releaseId: 'rel-router-1',
    status: 'completed',
    seconds: 180,
    tagged: true,
  },
  'call-direct-1': {
    agentId: 'agent-sales',
    releaseId: 'rel-sales-0001',
    status: 'completed',
    seconds: 95,
    tagged: false,
  },
  'call-unavailable-1': {
    agentId: 'agent-sales',
    releaseId: 'rel-sales-0001',
    status: 'completed',
    seconds: 60,
    tagged: false,
  },
  'call-segdown-1': {
    agentId: 'agent-sales',
    releaseId: 'rel-sales-0001',
    status: 'failed',
    seconds: 30,
    tagged: false,
  },
  'call-fallback-1': {
    agentId: 'agent-router',
    releaseId: 'rel-router-1',
    status: 'completed',
    seconds: 70,
    tagged: false,
  },
  'call-live-1': {
    agentId: 'agent-router',
    releaseId: 'rel-router-1',
    status: 'in_progress',
    seconds: null,
    tagged: false,
  },
};

function callRow(id) {
  const spec = CALLS[id];
  return {
    id,
    agentId: spec.agentId,
    releaseId: spec.releaseId,
    kind: 'live',
    status: spec.status,
    createdAt: at(0),
    completedAt: spec.seconds == null ? null : at(spec.seconds),
  };
}

const outcome = (patch = {}) => ({
  callId: 'x',
  outcome: 'completed',
  endReason: 'caller_hangup',
  disposition: null,
  dispositionSource: null,
  finalNode: null,
  statePath: [],
  variables: {},
  tiers: {},
  guardrail: { flagged: 0, blocked: 0 },
  route: null,
  segments: [],
  transfers: { requested: 0, refused: 0, connected: 0, failed: 0 },
  human: null,
  events: 0,
  updatedAt: at(1),
  ...patch,
});
const routedOutcome = () => {
  const body = routedSegments();
  return outcome({
    route: body.route,
    segments: body.segments.map(({ cost: _cost, ...rest }) => rest),
    transfers: { requested: 3, refused: 1, connected: 2, failed: 0 },
    human: {
      queueKey: 'desk',
      queueId: 'q-desk',
      kind: 'managed',
      ticket: 'ticket-9',
      requested: 1,
      connected: 1,
      waitMs: 19000,
      talkMs: 44800,
      outcome: 'connected',
      operator: 'u-asha',
      callbacks: { accepted: true, released: false, outcome: null },
    },
  });
};
const OUTCOMES = {
  'call-routed-1': routedOutcome,
  'call-direct-1': () => outcome({ disposition: 'promise_to_pay', endReason: 'agent_end:goodbye' }),
  'call-unavailable-1': () => outcome(),
  'call-segdown-1': () => outcome({ endReason: 'error:timeout:stt' }),
};
// The Calls list: the fallback call is a second routed call that used the default agent.
const FALLBACK_OUTCOME = () =>
  outcome({
    route: {
      routingPointId: 'point-2',
      routingReleaseId: 'rel-2',
      path: ['intent'],
      target: 'agent',
      agentId: 'agent-sales',
      releaseId: 'rel-sales-0001',
      poolId: null,
      memberId: null,
      language: 'en',
      degraded: 'router_compose_failed',
      segments: 1,
      fallbacks: 2,
    },
  });

function listRows(url, nooutcomes) {
  const rows = [
    { ...callRow('call-routed-1'), outcome: OUTCOMES['call-routed-1']() },
    { ...callRow('call-direct-1'), outcome: OUTCOMES['call-direct-1']() },
    {
      ...callRow('call-fallback-1'),
      agentId: 'agent-router',
      releaseId: 'rel-router-1',
      status: 'completed',
      completedAt: at(70),
      outcome: FALLBACK_OUTCOME(),
    },
    { ...callRow('call-live-1'), outcome: null },
  ];
  if (nooutcomes)
    return { rows: rows.map((row) => ({ ...row, outcome: null })), unavailable: true };
  const q = url.searchParams;
  return {
    rows: rows.filter((row) => {
      const o = row.outcome;
      if (q.get('routingPointId') && o?.route?.routingPointId !== q.get('routingPointId'))
        return false;
      if (
        q.get('segmentAgentId') &&
        !o?.segments?.some((s) => s.agentId === q.get('segmentAgentId'))
      )
        return false;
      if (q.get('transferred') === '1' && !(o?.transfers?.connected > 0)) return false;
      if (q.get('human') === '1' && !o?.human) return false;
      if (q.get('fallback') === '1' && !((o?.route?.fallbacks ?? 0) > 0 || o?.route?.degraded))
        return false;
      if (q.get('status') && row.status !== q.get('status')) return false;
      return true;
    }),
    unavailable: false,
  };
}

function evidence(id) {
  const spec = CALLS[id];
  const tag = (index) => (spec.tagged ? index : undefined);
  return {
    call: {
      id,
      agentId: spec.agentId,
      releaseId: spec.releaseId,
      kind: 'live',
      status: spec.status,
      createdAt: at(0),
      completedAt: spec.seconds == null ? null : at(spec.seconds),
      durationMs: spec.seconds == null ? undefined : spec.seconds * 1000,
    },
    selections: { stt: { pluginId: 'stt-fixture', version: '1.0.0' } },
    transcript: [
      line('t0', 'Agent', 'Namaste, welcome to Sunrise Finance. How can I help?', 500, tag(0)),
      line('t1', 'User', 'Mujhe naya credit card chahiye.', 4000, tag(0)),
      line('t2', 'Agent', 'Sales here. Let me check the best card for you.', 9000, tag(1)),
      line('t3', 'User', 'Meri instalment do baar kat gayi hai.', 60000, tag(1)),
      line('t4', 'Agent', 'I am sorry about that. Billing can fix it.', 68000, tag(1)),
      line('t5', 'Agent', 'Billing here. I can see the duplicate charge.', 75000, tag(2)),
    ],
    latency: [],
    cost: {
      currencies: [{ currency: 'INR', estimatedMinor: '1530', reconciledMinor: '0', lines: 4 }],
      lines: [],
    },
    events: [],
  };
}

const run = (id, name, version, createdAt, headline) => ({
  id,
  name,
  routingReleaseId: `rr-${version}`,
  routingPointId: 'point-1',
  releaseVersion: version,
  createdAt,
  createdBy: 'asha@sunrise.example',
  engineMode: 'recorded',
  caseCount: headline.total,
  headline,
});
const RUNS = [
  run('run-3', 'Worked examples', 3, '2026-10-19T09:00:00.000Z', {
    passed: 43,
    total: 45,
    accuracy: 0.9556,
    fallbackRate: 0.1556,
    clarifyRate: 0.0667,
  }),
  run('run-2', 'Hindi sales', 2, '2026-10-18T09:00:00.000Z', {
    passed: 18,
    total: 20,
    accuracy: 0.9,
    fallbackRate: 0.2,
    clarifyRate: 0.05,
  }),
  run('run-1', 'Smoke', 1, '2026-10-17T09:00:00.000Z', {
    passed: 8,
    total: 10,
    accuracy: 0.8,
    fallbackRate: 0.3,
    clarifyRate: 0.1,
  }),
];
const rate = (correct, total) => ({ correct, total, rate: total ? correct / total : null });
const counts = (patch) => ({
  attempts: 0,
  matched: 0,
  no_match: 0,
  low_confidence: 0,
  timeout: 0,
  error: 0,
  disabled: 0,
  ...patch,
});
const fullRun = (summary) => ({
  ...summary,
  corpusDigest: 'a'.repeat(64),
  scorecard: {
    schema: 'ovo.routing-scorecard/1',
    engineMode: 'recorded',
    corpus: { name: 'worked-example', digest: 'a'.repeat(64), cases: summary.caseCount },
    routing: {
      pointId: 'point-1',
      routingReleaseId: summary.routingReleaseId,
      digest: 'b'.repeat(64),
    },
    totals: {
      cases: summary.headline.total,
      passed: summary.headline.passed,
      failed: summary.headline.total - summary.headline.passed,
    },
    accuracy: {
      overall: rate(43, 45),
      status: rate(45, 45),
      path: rate(40, 42),
      node: rate(0, 0),
      branch: rate(31, 33),
      pool: rate(20, 20),
      member: rate(18, 20),
      agent: rate(0, 0),
      queue: rate(4, 4),
      language: rate(30, 30),
    },
    fallbackRate: { ...rate(7, 45), byStep: { default: 5, release_default: 2 } },
    clarifyRate: rate(3, 45),
    endRate: rate(2, 45),
    perEngine: {
      rules: counts({ attempts: 60, matched: 52, no_match: 8 }),
      llm: counts({ attempts: 33, matched: 28, low_confidence: 5 }),
    },
    confusion: {
      llm: {
        labels: ['sales', 'support', 'none'],
        matrix: [
          [18, 1, 0],
          [1, 9, 0],
          [0, 1, 3],
        ],
        correct: 30,
        total: 33,
      },
    },
    perNode: [
      { node: 'language', cases: 45, decided: 45, correct: 45, fallbacks: 0 },
      { node: 'intent', cases: 40, decided: 36, correct: 33, fallbacks: 7 },
    ],
    byTag: { sales: { cases: 12, passed: 12 } },
    failures: [
      {
        id: 'support-hi-low-confidence',
        expected: { status: 'agent', member: 'support-hi' },
        actual: { status: 'agent', member: 'support-en' },
        diff: ['member'],
      },
    ],
    ms: { total: 412, p50: 7, p95: 21 },
  },
});

/** Answers a call, agent, evaluation or routing eval request; false when the path is not ours. */
export async function handleInspectorApi(request, response, scenario) {
  const url = new URL(request.url, 'http://fixture');
  const path = url.pathname;
  const cookie = request.headers.cookie ?? '';
  const mine = cookie.includes('ovo_inspector=');
  const nooutcomes = cookie.includes('ovo_inspector=nooutcomes');
  const own =
    /^\/v1\/(calls|evaluation-datasets|evaluation-runs|evaluation-provider-authorizations|routing\/eval-runs)(\/|$)/;
  const shared = /^\/v1\/(agents|plugins|routing\/status|routing\/points)(\/|$)/;
  if (!own.test(path) && !(mine && shared.test(path))) return false;
  const method = request.method;
  if (scenario === 'down' && method === 'GET')
    return (
      json(response, 503, { error: { code: 'unavailable', message: 'Fixture is down' } }),
      true
    );
  if (path === '/v1/routing/status')
    return (
      json(response, 200, {
        enabled: scenario !== 'disabled',
        externalEnabled: false,
        transferEnabled: true,
        humanQueueEnabled: true,
        outcomesAvailable: !nooutcomes,
      }),
      true
    );
  if (scenario === 'disabled' && path.startsWith('/v1/routing/'))
    return (
      json(response, 404, {
        error: { code: 'routing_disabled', message: 'Routing is not enabled' },
      }),
      true
    );

  if (path === '/v1/plugins') return (json(response, 200, { plugins: [] }), true);
  if (/^\/v1\/evaluation/.test(path))
    return (json(response, 200, { items: [], nextCursor: null }), true);

  if (path === '/v1/agents')
    return (
      json(response, 200, {
        items: AGENTS.map((a) => ({ id: a.id, draftVersion: '1', config: { name: a.name } })),
        nextCursor: null,
      }),
      true
    );
  const agent = /^\/v1\/agents\/([^/]+)(?:\/(releases))?$/.exec(path);
  if (agent) {
    const found = AGENTS.find((a) => a.id === agent[1]);
    if (!found)
      return (
        json(response, 404, { error: { code: 'not_found', message: 'Agent missing' } }),
        true
      );
    if (agent[2])
      return (
        json(response, 200, {
          items: [{ id: found.release, config: { name: found.name } }],
          nextCursor: null,
        }),
        true
      );
    return (
      json(response, 200, { id: found.id, draftVersion: '1', config: { name: found.name } }),
      true
    );
  }

  if (path === '/v1/routing/points')
    return (json(response, 200, { items: POINTS, nextCursor: null }), true);
  const releases = /^\/v1\/routing\/points\/([^/]+)\/releases$/.exec(path);
  if (releases)
    return (
      json(response, 200, {
        items: [
          { id: 'rr-3', version: 3 },
          { id: 'rr-2', version: 2 },
        ],
        nextCursor: null,
      }),
      true
    );

  if (path === '/v1/routing/eval-runs' && method === 'GET')
    return (
      json(response, 200, { items: scenario === 'empty' ? [] : RUNS, nextCursor: null }),
      true
    );
  if (path === '/v1/routing/eval-runs' && method === 'POST') {
    const body = await readBody(request);
    const created = run('run-new', body.name ?? 'New run', 3, '2026-10-20T09:00:00.000Z', {
      passed: body.cases?.length ?? 1,
      total: body.cases?.length ?? 1,
      accuracy: 1,
      fallbackRate: 0,
      clarifyRate: 0,
    });
    return (json(response, 201, fullRun(created)), true);
  }
  const one = /^\/v1\/routing\/eval-runs\/([^/]+)$/.exec(path);
  if (one) {
    if (method === 'DELETE') return (response.writeHead(204), response.end(), true);
    const summary = RUNS.find((r) => r.id === one[1]);
    return summary
      ? (json(response, 200, fullRun(summary)), true)
      : (json(response, 404, { error: { code: 'not_found', message: 'Run missing' } }), true);
  }

  if (path === '/v1/calls' && method === 'GET') {
    if (scenario === 'empty') return (json(response, 200, { items: [], nextCursor: null }), true);
    const { rows, unavailable } = listRows(url, nooutcomes);
    return (
      json(response, 200, {
        items: rows,
        nextCursor: null,
        ...(unavailable ? { filterUnavailable: true } : {}),
      }),
      true
    );
  }
  const callPath = /^\/v1\/calls\/([^/]+)\/([a-z]+)$/.exec(path);
  if (callPath) {
    const [, id, what] = callPath;
    if (!CALLS[id])
      return (
        json(response, 404, { error: { code: 'not_found', message: 'Call not found' } }),
        true
      );
    if (what === 'evidence') return (json(response, 200, evidence(id)), true);
    if (what === 'turns') return (json(response, 200, { turns: [] }), true);
    if (what === 'outcome')
      return (json(response, 200, { available: false, summary: null, events: [] }), true);
    if (what === 'cost')
      return (json(response, 404, { error: { code: 'not_found', message: 'No ledger' } }), true);
    if (what === 'segments') {
      if (id === 'call-routed-1') return (json(response, 200, routedSegments()), true);
      if (id === 'call-unavailable-1')
        return (json(response, 200, { callId: id, ...NO_ROUTE, available: false }), true);
      if (id === 'call-segdown-1')
        return (
          json(response, 503, {
            error: { code: 'unavailable', message: 'The outcome store is down' },
          }),
          true
        );
      return (json(response, 200, { callId: id, ...NO_ROUTE }), true);
    }
  }
  return false;
}
