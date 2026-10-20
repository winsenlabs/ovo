// Deterministic data for the routing fixture API (Wave 18): one rich routing point with a nested
// tree, two pools, three releases, hold clips and three numbers. Ids are real UUIDs so a draft
// parses with the console's contract schema, as a real API draft would.
export const IDS = {
  point: '5b0f2d3a-1c4e-4f6a-9d21-0a7b8c9d0e11',
  point2: '6c1a3e4b-2d5f-4a7b-8e32-1b8c9d0e1f22',
  sales: 'a1111111-1111-4111-8111-111111111111',
  support: 'a2222222-2222-4222-8222-222222222222',
  r1: 'c1111111-1111-4111-8111-111111111111',
  r2: 'c2222222-2222-4222-8222-222222222222',
  r3: 'c3333333-3333-4333-8333-333333333333',
  clip: 'd1111111-1111-4111-8111-111111111111',
  clip2: 'd2222222-2222-4222-8222-222222222222',
  queueDesk: 'e1111111-1111-4111-8111-111111111111',
  queueBilling: 'e2222222-2222-4222-8222-222222222222',
  queueAcd: 'e3333333-3333-4333-8333-333333333333',
};
export const QUEUE_ID_MAP = {
  'q-support': IDS.queueDesk,
  'q-billing': IDS.queueBilling,
  'q-acd': IDS.queueAcd,
};
const AT = '2026-10-14T09:00:00.000Z';
const latest = (agentId) => ({ agentId, release: { kind: 'latest' } });
const en = (text) => ({ en: text });

export const draft = () => ({
  name: 'Main line',
  description: 'Sunrise Finance inbound line',
  router: latest('agent-front'),
  defaultTarget: latest('agent-sales-en'),
  language: { default: 'en', allowed: ['en', 'hi', 'ta'] },
  greeting: {
    en: 'Welcome to Sunrise Finance. How can I help you today?',
    hi: 'Sunrise Finance mein aapka swagat hai.',
  },
  connecting: en('Connecting you now.'),
  root: 'intent',
  nodes: [
    {
      id: 'intent',
      sets: 'intent',
      ask: en('Are you calling to buy something new, or about an existing account?'),
      engines: [
        {
          kind: 'rules',
          rules: [
            { branch: 'sales', when: [{ kind: 'dtmf', digits: '1' }] },
            { branch: 'support', when: [{ kind: 'dtmf', digits: '2' }] },
          ],
        },
        {
          kind: 'llm',
          instructions: 'Decide why the caller is calling.',
          threshold: 0.6,
          timeoutMs: 2500,
          detectLanguage: true,
          generatedClarify: false,
        },
      ],
      branches: [
        {
          key: 'sales',
          description: 'Wants to buy, asks about prices, new cards or loans',
          target: { kind: 'pool', poolId: IDS.sales, language: 'caller', skills: [] },
        },
        {
          key: 'support',
          description: 'Has a problem with an existing account or payment',
          next: 'support_kind',
        },
        {
          key: 'person',
          description: 'Asks for a person',
          target: { kind: 'human', queueId: 'desk' },
        },
      ],
      fallback: [
        { kind: 'reask', times: 1 },
        { kind: 'default' },
        { kind: 'end', line: en('Sorry, we could not connect you. Goodbye.') },
      ],
      reuseTurn: true,
    },
    {
      id: 'support_kind',
      ask: en('Is it about a payment, or something else?'),
      engines: [
        {
          kind: 'rules',
          rules: [
            {
              branch: 'billing',
              when: [{ kind: 'keywords', words: ['payment', 'refund', 'charged'], maxWords: 12 }],
            },
          ],
        },
        {
          kind: 'decision',
          instructions: 'Choose the kind of support the caller needs.',
          threshold: 0.7,
          timeoutMs: 800,
        },
      ],
      branches: [
        {
          key: 'billing',
          description: 'Payment, refund or a wrong charge',
          target: {
            kind: 'pool',
            poolId: IDS.support,
            language: 'caller',
            products: { values: ['billing'] },
            skills: [],
          },
        },
        {
          key: 'other',
          description: 'Anything else about an account',
          target: { kind: 'pool', poolId: IDS.support, language: 'caller', skills: [] },
        },
      ],
      fallback: [{ kind: 'default' }],
      reuseTurn: true,
    },
  ],
  limits: { maxTurns: 6, maxRouteSeconds: 90 },
  idle: { timeoutMs: 8000, prompts: [en('Are you still there?')] },
  transfer: {
    targets: [
      {
        key: 'billing',
        description: 'Payments, refunds and wrong charges',
        destination: {
          kind: 'pool',
          poolId: IDS.support,
          language: 'caller',
          products: { values: ['billing'] },
          skills: [],
        },
        hold: {
          steps: [
            { kind: 'clip', assetId: IDS.clip },
            { kind: 'line', line: en('Thank you for holding.') },
          ],
          loopFrom: 0,
          maxSeconds: 90,
          waitForCapacity: true,
          onTimeout: [
            { kind: 'default' },
            { kind: 'end', line: en('Sorry, nobody is free. Goodbye.') },
          ],
        },
      },
      {
        key: 'sales_desk',
        description: 'Buying a new product',
        destination: { kind: 'pool', poolId: IDS.sales, language: 'caller', skills: [] },
      },
    ],
    announcement: en('I am transferring your call now.'),
    confirm: 'never',
    hold: {
      steps: [
        { kind: 'silence', seconds: 3 },
        { kind: 'line', line: en('Someone will be with you shortly.') },
      ],
      loopFrom: 0,
      maxSeconds: 60,
      waitForCapacity: false,
      onTimeout: [{ kind: 'default' }, { kind: 'end', line: en('Goodbye.') }],
    },
    limits: { maxTransfers: 3, returnToPrevious: 'refuse', minRemainingSeconds: 30 },
    handover: { summary: true, transcriptTurns: 6, capturedVariables: true },
  },
  humanQueues: [{ key: 'desk', queueId: IDS.queueDesk, priority: 1 }],
});

export const point = (id = IDS.point) => ({
  id,
  workspaceId: 'fixture-workspace',
  draft:
    id === IDS.point ? draft() : { ...draft(), name: 'After-hours line', description: undefined },
  draftVersion: id === IDS.point ? 4 : 1,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: AT,
});

export const summaryOf = (p) => ({
  nodes: p.draft.nodes.length,
  pools: 2,
  languages: [...p.draft.language.allowed],
  humanQueues: p.draft.humanQueues?.length ?? 0,
  latestRelease:
    p.id === IDS.point ? { id: IDS.r3, version: 3, digest: 'f'.repeat(64), draftVersion: 3 } : null,
  published: false,
  numbers: p.id === IDS.point ? 2 : 0,
});

export const releases = () => [
  {
    id: IDS.r3,
    version: 3,
    digest: 'c'.repeat(64),
    draftVersion: 3,
    createdAt: '2026-10-12T09:00:00.000Z',
    createdBy: 'asha@sunrise.example',
    counts: { nodes: 2, pools: 2, members: 5 },
  },
  {
    id: IDS.r2,
    version: 2,
    digest: 'b'.repeat(64),
    draftVersion: 2,
    createdAt: '2026-10-08T09:00:00.000Z',
    createdBy: 'asha@sunrise.example',
    counts: { nodes: 2, pools: 2, members: 4 },
  },
  {
    id: IDS.r1,
    version: 1,
    digest: 'a'.repeat(64),
    draftVersion: 1,
    createdAt: '2026-10-02T09:00:00.000Z',
    createdBy: 'ravi@sunrise.example',
    counts: { nodes: 1, pools: 1, members: 2 },
  },
];

export const release = (id) => {
  const meta = releases().find((r) => r.id === id) ?? releases()[0];
  const snapshot = {
    ...draft(),
    schemaVersion: 3,
    routingPointId: IDS.point,
    pools: {},
    queues: {},
    releaseIds: [],
  };
  if (meta.version === 1) {
    snapshot.nodes = snapshot.nodes.slice(0, 1);
    snapshot.nodes[0] = { ...snapshot.nodes[0], branches: snapshot.nodes[0].branches.slice(0, 1) };
  }
  return {
    id: meta.id,
    workspaceId: 'fixture-workspace',
    routingPointId: IDS.point,
    version: meta.version,
    draftVersion: meta.draftVersion,
    snapshot,
    digest: meta.digest,
    createdAt: meta.createdAt,
    createdBy: meta.createdBy,
  };
};

const member = (id, agentId, languages, extra = {}) => ({
  id,
  agent: latest(agentId),
  languages,
  products: ['cards', 'loans', 'billing'],
  skills: [],
  priority: 50,
  enabled: true,
  ...extra,
});
export const pools = () => [
  {
    id: IDS.sales,
    workspaceId: 'fixture-workspace',
    version: 2,
    createdAt: AT,
    updatedAt: AT,
    usedBy: [IDS.point],
    definition: {
      name: 'Sales',
      description: 'Sales agents, one per language',
      languageFallback: ['en'],
      members: [
        member('sales-en', 'agent-sales-en', ['en'], { capacity: 20 }),
        member('sales-hi', 'agent-sales-hi', ['hi'], {
          capacity: 20,
          priority: 60,
          hours: {
            timezone: 'Asia/Kolkata',
            weekly: {
              mon: [{ start: '09:00', end: '21:00' }],
              tue: [{ start: '09:00', end: '21:00' }],
              wed: [{ start: '09:00', end: '21:00' }],
              thu: [{ start: '09:00', end: '21:00' }],
              fri: [{ start: '09:00', end: '21:00' }],
            },
            closed: [],
          },
        }),
        member('sales-ta', 'agent-sales-ta', ['ta'], { capacity: 10, enabled: false }),
      ],
    },
  },
  {
    id: IDS.support,
    workspaceId: 'fixture-workspace',
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    usedBy: [IDS.point],
    definition: {
      name: 'Support',
      languageFallback: [],
      members: [member('support-en', 'agent-support', ['en', 'hi'])],
    },
  },
];

export const audio = () => [
  {
    id: IDS.clip,
    workspaceId: 'fixture-workspace',
    name: 'Hold music',
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    durationMs: 42_000,
    byteLength: 336_000,
    sha256: '1'.repeat(64),
    source: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 44100, channels: 2 },
    createdAt: AT,
    createdBy: 'asha@sunrise.example',
  },
  {
    id: IDS.clip2,
    workspaceId: 'fixture-workspace',
    name: 'Please hold (Hindi)',
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    durationMs: 6_500,
    byteLength: 52_000,
    sha256: '2'.repeat(64),
    source: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 },
    createdAt: AT,
    createdBy: 'asha@sunrise.example',
  },
];

const number = (phoneNumber, extra) => ({
  organizationId: 'workspace-1',
  phoneNumber,
  releaseId: null,
  routingReleaseId: null,
  routing: null,
  carrierPluginId: null,
  carrierBindingId: null,
  variables: {},
  enabled: true,
  version: 2,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});
export const numbers = () => [
  number('+918069450000', {
    routingReleaseId: IDS.r3,
    routing: { pointId: IDS.point, pointName: 'Main line', version: 3 },
  }),
  number('+918069450001', {
    routingReleaseId: IDS.r2,
    routing: { pointId: IDS.point, pointName: 'Main line', version: 2 },
  }),
  number('+918040000001', { releaseId: 'f0000000-0000-4000-8000-000000000001' }),
];

export const stats = (window) => {
  const buckets = window === '24h' ? 24 : window === '7d' ? 7 : 30;
  const series = Array.from({ length: buckets }, (_, i) => {
    const agent = 10 + ((i * 7) % 13);
    return {
      at: new Date(
        Date.UTC(2026, 9, 14, window === '24h' ? i : 0) + (window === '24h' ? 0 : i * 86_400_000),
      ).toISOString(),
      routed: agent + 4,
      agent,
      human: 2,
      end: 1,
      callback: 1,
      fallback: i % 4,
    };
  });
  const sum = (k) => series.reduce((s, b) => s + b[k], 0);
  return {
    available: true,
    window,
    since: series[0].at,
    until: series.at(-1).at,
    bucket: window === '24h' ? 'hour' : 'day',
    totals: {
      routed: sum('routed'),
      undecided: 0,
      byTarget: {
        agent: sum('agent'),
        human: sum('human'),
        end: sum('end'),
        callback: sum('callback'),
      },
      degraded: 3,
      withFallback: sum('fallback'),
      withReask: 11,
      transferred: 9,
      reachedPerson: sum('human'),
      avgTurns: 2.1,
      routeMsP50: 5200,
      routeMsP95: 11800,
    },
    series,
    points: [
      {
        pointId: IDS.point,
        routed: sum('routed'),
        withFallback: sum('fallback'),
        human: sum('human'),
      },
    ],
    pools: [],
  };
};

export const utilisation = (poolId) => {
  const pool = pools().find((p) => p.id === poolId) ?? pools()[0];
  const members = pool.definition.members.map((m, i) => ({
    memberId: m.id,
    active: m.enabled ? (i + 1) * 3 : 0,
    capacity: m.capacity ?? null,
    enabled: m.enabled,
    open: true,
  }));
  return {
    poolId: pool.id,
    at: new Date().toISOString(),
    members,
    total: {
      active: members.reduce((s, m) => s + m.active, 0),
      capacity: members.every((m) => m.capacity)
        ? members.reduce((s, m) => s + m.capacity, 0)
        : null,
    },
  };
};

export const activity = (id, window) => ({
  queueId: id,
  window,
  stats: {
    created: 64,
    handled: 58,
    abandoned: 4,
    expired: 1,
    webhookFailed: 0,
    avgWaitMs: 48_000,
    p95WaitMs: 131_000,
    avgTalkMs: 312_000,
    byOutcome: { resolved: 41, escalated: 12, callback: 5 },
  },
  tickets: Array.from({ length: 6 }, (_, i) => ({
    id: `t-${100 + i}`,
    callId: `call-8d41c7a${i}`,
    status: i === 0 ? 'waiting' : 'released',
    priority: i % 3,
    language: i % 2 ? 'hi' : 'en',
    createdAt: new Date(Date.UTC(2026, 9, 14, 9, i * 7)).toISOString(),
    waitMs: 20_000 + i * 9_000,
    releasedAt: i === 0 ? undefined : new Date(Date.UTC(2026, 9, 14, 9, i * 7 + 6)).toISOString(),
    releaseCode: i === 0 ? undefined : 'operator_ended',
    outcome: i === 0 ? undefined : 'resolved',
    operatorId: i === 0 ? undefined : 'fixture-admin',
  })),
});

export const agents = () =>
  [
    ['agent-front', 'Front desk'],
    ['agent-sales-en', 'Sales (English)'],
    ['agent-sales-hi', 'Sales (Hindi)'],
    ['agent-sales-ta', 'Sales (Tamil)'],
    ['agent-support', 'Support'],
  ].map(([id, name]) => ({ id, draftVersion: '1', config: { name, timezone: 'Asia/Kolkata' } }));
