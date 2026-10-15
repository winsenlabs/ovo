import { vi } from 'vitest';
import {
  HumanQueueDefinition,
  type RoutingPointDraft,
} from '../../../packages/contracts/src/index.ts';
import { startFakeAcd, ACD_HOST, ACD_PATH, type FakeAcd } from './fake-acd.ts';
import { startFakeTwilioRest } from './fake-providers.ts';
import {
  carrierUrls,
  configureInboundAgent,
  operatorApi,
  type Operator,
} from './operator-setup.ts';
import { LINES, mainLineDraft, type RoutedAgent } from './routing-setup.ts';
import { startScriptedAssemblyAi } from './routing-fakes.ts';
import { startLiveStack, type LiveStack } from './stack.ts';
import { startTransferOpenAi, TRANSFER_LINES, type TransferOpenAi } from './transfer-setup.ts';

const TWILIO = '@winsendotai/ovo-carrier-twilio';

/** What the queues and the agents say, so a test can tell from the synthesised speech who spoke. */
export const HUMAN_LINES = {
  ...LINES,
  announcement: 'I am connecting you to a colleague. Please hold.',
  hold: 'Thanks for holding, a colleague will be with you shortly.',
  returned: 'Sorry, nobody could take your call. I am still here with you.',
  callback: 'We will call you back soon. Goodbye.',
  end: 'Thank you for calling. Goodbye.',
  floorAnnouncement: 'Connecting you to our team now.',
  floorHold: 'All our colleagues are busy, please keep holding.',
  sales: 'Hello, this is sales. How can I help?',
};
/** The two secrets of the third party's webhook: the HMAC key and the api key header. */
export const ACD_SECRET = 'acd-hmac-secret-0123456789abcdef';
export const ACD_API_KEY = 'acd-api-key-9876543210';
/** Context a scenario asserts the third party got only when the queue's policy allows it. */
export const CALLER_NUMBER = '+919800000001';
export const ACCOUNT_ID = 'ACC-4471';

type Patch = Record<string, unknown>;

/** The external queue's hold: one reassurance line on a loop, then return, call back, end. */
export function holdPolicy(maxSeconds: number) {
  return {
    steps: [{ kind: 'line', line: { en: HUMAN_LINES.hold } }],
    loopFrom: 0,
    maxSeconds,
    onTimeout: [
      { kind: 'return' },
      { kind: 'callback', inMinutes: 60, line: { en: HUMAN_LINES.callback } },
      { kind: 'end', line: { en: HUMAN_LINES.end } },
    ],
  };
}

/** The worked external queue of the design (section 10.2), pointed at the fake ACD. */
export function externalQueueInput(
  credentials: { hmac: string; key: string },
  patch: Patch = {},
): Record<string, any> {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    kind: 'external',
    name: 'Acme ACD',
    announcement: { en: HUMAN_LINES.announcement },
    hold: holdPolicy(30),
    webhook: {
      url: `https://${ACD_HOST}${ACD_PATH}`,
      credentialId: credentials.hmac,
      auth: { kind: 'header', name: 'X-Api-Key', credentialId: credentials.key },
      body: {
        callId: { $from: 'call.id' },
        lang: { $from: 'route.language', default: 'en' },
        notes: { $template: 'Intent {{route.intent}}: {{handover.summary}}', maxChars: 500 },
        account: { $from: 'variables.account_id' },
        replyTo: { $from: 'ticket.callbackUrl' },
        ref: { $from: 'ticket.idempotencyKey' },
      },
      response: {
        statusPath: '/result',
        acceptedValues: ['ok'],
        queuedValues: ['queued'],
        rejectedValues: ['no'],
        ticketRefPath: '/ref',
        destinationE164Path: '/dial/number',
        destinationSipUriPath: '/dial/uri',
        destinationHeadersPath: '/dial/headers',
      },
      timeoutMs: 6000,
      retry: { attempts: 3, baseMs: 500, maxMs: 5000, deadlineMs: 15000 },
    },
    destination: {
      allowE164Prefixes: ['+9140'],
      allowSipHosts: [`.${ACD_HOST}`],
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
    ...patch,
  };
}

/** A desk queue for the operator scenarios. */
export function managedQueueInput(patch: Patch = {}): Record<string, any> {
  // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    kind: 'managed',
    name: 'Floor',
    assignment: 'AUTO_ASSIGN',
    teamIds: [],
    announcement: { en: HUMAN_LINES.floorAnnouncement },
    hold: {
      steps: [{ kind: 'line', line: { en: HUMAN_LINES.floorHold } }],
      loopFrom: 0,
      maxSeconds: 8,
      onTimeout: [{ kind: 'return' }, { kind: 'default' }],
    },
    offerSeconds: 10,
    joinSeconds: 15,
    returnTargets: ['sales'],
    returnDefault: 'sales',
    wrapUp: { required: false, dispositions: [] },
    ...patch,
  };
}

export interface HumanLineOptions {
  /** Patches the external queue; `false` creates none. */
  external?: Patch | false;
  /** Creates a managed queue (patched); absent: none. */
  managed?: Patch | boolean;
  /** Also bind a transfer target `colleague` for the sales agent to the external queue. */
  transfer?: boolean;
  /** The router agent records the call (the recording tap sees both sides of a room). */
  recording?: boolean;
  /** The node fallback steps; the default is `human desk`, the release default, an end line. */
  fallback?: unknown[];
}

export interface HumanLine {
  router: RoutedAgent;
  fallback: RoutedAgent;
  sales: RoutedAgent;
  support: RoutedAgent;
  credentials: { hmac: string; key: string };
  queues: { desk?: string; floor?: string };
  pools: { sales: string; support: string };
  routingPointId: string;
  routingReleaseId: string;
}

const pinned = ({ agentId, releaseId }: RoutedAgent) => ({
  agentId,
  release: { kind: 'pinned' as const, releaseId },
});

/**
 * The R1 main line with human queues: digit 1 sales, 2 support, 3 the desk queue (when a managed
 * queue exists), and a classifier miss falls to the external queue `desk` before the default
 * agent. Sales may send a caller to `colleague` (the external queue) when `transfer` is set.
 */
export async function configureHumanLine(
  operator: Operator,
  base: Awaited<ReturnType<typeof configureInboundAgent>>,
  options: HumanLineOptions = {},
): Promise<HumanLine> {
  const call = operatorApi(operator);
  const secret = (label: string, value: string) =>
    call<{ id: string }>('POST', '/v1/credentials', {
      label,
      provider: 'webhook',
      type: 'api-key',
      environment: 'live',
      value,
    }).then((credential) => credential.id);
  const credentials = {
    hmac: await secret('acd signing secret', ACD_SECRET),
    key: await secret('acd api key', ACD_API_KEY),
  };
  const agent = async (key: string, config: Record<string, unknown>): Promise<RoutedAgent> => {
    const created = await call<{ id: string }>('POST', '/v1/agents', {
      config: {
        ...base.config,
        name: key,
        context: `${String(base.config.context)} [agent:${key}]`,
        ...config,
      },
    });
    const release = await call<{ id: string }>('POST', `/v1/agents/${created.id}/releases`, {});
    return { agentId: created.id, releaseId: release.id };
  };
  const strings = (...names: string[]) => ({
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
    additionalProperties: false,
  });
  const team = {
    router: await agent('router', {
      variables: strings('account_id'),
      ...(options.recording ? { recording: true } : {}),
    }),
    fallback: await agent('fallback', { opening: { lines: [LINES.fallback] } }),
    sales: await agent('sales-en', {
      opening: { lines: [HUMAN_LINES.sales] },
      handoff: { agents: { llmTool: true } },
    }),
    support: await agent('support', { opening: { lines: [LINES.support] } }),
  };
  const member = (id: string, who: RoutedAgent, extra: object = {}) => ({
    id,
    agent: pinned(who),
    languages: ['en'],
    products: [],
    skills: [],
    priority: 50,
    enabled: true,
    ...extra,
  });
  const pool = async (name: string, members: object[]) =>
    (
      await call<{ id: string }>('POST', '/v1/routing/pools', {
        definition: { name, languageFallback: [], members },
      })
    ).id;
  const sales = await pool('Sales', [member('sales-en', team.sales, { capacity: 2 })]);
  const support = await pool('Support', [member('support', team.support)]);

  const queues: HumanLine['queues'] = {};
  if (options.external !== false) {
    const definition = HumanQueueDefinition.parse(
      externalQueueInput(credentials, options.external),
    );
    queues.desk = (await call<{ id: string }>('POST', '/v1/human-queues', { definition })).id;
  }
  if (options.managed) {
    const definition = HumanQueueDefinition.parse(
      managedQueueInput(options.managed === true ? {} : options.managed),
    );
    queues.floor = (await call<{ id: string }>('POST', '/v1/human-queues', { definition })).id;
  }

  const draft: RoutingPointDraft & Record<string, any> = mainLineDraft(team, sales, support); // eslint-disable-line @typescript-eslint/no-explicit-any
  const bound = [
    ...(queues.desk ? [{ key: 'desk', queueId: queues.desk }] : []),
    ...(queues.floor ? [{ key: 'floor', queueId: queues.floor }] : []),
  ];
  draft.humanQueues = bound;
  const node = draft.nodes[0]!;
  (node.engines[0] as any).rules.push({ branch: 'person', when: [{ kind: 'dtmf', digits: '3' }] }); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (queues.floor)
    node.branches.push({
      key: 'person',
      description: 'Wants to speak to a person at the desk',
      target: { kind: 'human', queueId: 'floor' },
    } as never);
  else
    node.branches.push({
      key: 'person',
      description: 'Wants to speak to a person',
      target: { kind: 'human', queueId: 'desk' },
    } as never);
  node.fallback = (options.fallback ?? [
    ...(queues.desk ? [{ kind: 'human', queueId: 'desk' }] : []),
    { kind: 'default' },
    { kind: 'end', line: { en: HUMAN_LINES.end } },
  ]) as never;
  const targets = [
    ...(options.transfer && queues.desk
      ? [
          {
            key: 'colleague',
            description: 'A human colleague on the phone desk',
            destination: { kind: 'human', queueId: 'desk' },
            from: [{ kind: 'pool', poolId: sales }],
          },
        ]
      : []),
    // A desk operator may send the caller back here (`returnTargets` names catalogue keys).
    ...(queues.floor
      ? [
          {
            key: 'sales',
            description: 'The caller wants to buy something',
            destination: { kind: 'pool', poolId: sales, language: 'any' },
          },
        ]
      : []),
  ];
  if (targets.length)
    draft.transfer = {
      announcement: { en: TRANSFER_LINES.announcement },
      limits: { maxTransfers: 3 },
      targets,
    };
  const point = await call<{ id: string; draftVersion: number }>('POST', '/v1/routing/points', {
    draft,
  });
  const release = await call<{ id: string }>('POST', `/v1/routing/points/${point.id}/releases`, {
    expectedDraftVersion: point.draftVersion,
  });
  await call('PUT', `/v1/operations/inbound/routes/${encodeURIComponent(base.number)}`, {
    expectedVersion: 1,
    routingReleaseId: release.id,
    variables: { account_id: ACCOUNT_ID },
    enabled: true,
    carrierPluginId: TWILIO,
    carrierBindingId: base.twilioBindingId,
  });
  return {
    ...team,
    credentials,
    queues,
    pools: { sales, support },
    routingPointId: point.id,
    routingReleaseId: release.id,
  };
}

export interface HumanStackOptions {
  /** `OVO_HUMAN_QUEUE_ENABLED` (default true). */
  humanQueue?: boolean;
  /** `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED` (default true). */
  webhook?: boolean;
  /** `.env` additions, rendered by Compose like the rest (a room server's, for instance). */
  variables?: Record<string, string>;
  /** A room server the stack's api and worker reach (`OVO_LIVEKIT_*`); absent: the feature is dark. */
  room?: { url: string; apiKey: string; apiSecret: string };
  /** Added to the worker's rendered environment only (a feature on in the api, off in the worker). */
  workerVariables?: Record<string, string>;
  line?: HumanLineOptions;
  /** Extra agents' answers: the router classifier's script is the openAi fake's `answer`. */
  replies?: Record<string, string>;
}

/**
 * One installation with fake providers on loopback, a fake third-party queue behind
 * `acd.example.com`, and a human line bound to the live-path number. `routes` is the test's DNS
 * override map (shared with `routedNodeNet` and `routedLookup`).
 */
export async function humanStack(
  postgresUrl: string,
  routes: Map<string, string>,
  options: HumanStackOptions = {},
) {
  const openAi = await startTransferOpenAi({
    router: 'Sure.',
    'sales-en': 'Sure, let me check that for you.',
    support: 'Support here.',
    ...options.replies,
  });
  const stt = await startScriptedAssemblyAi();
  const twilioRest = await startFakeTwilioRest();
  const acd = await startFakeAcd({
    secret: ACD_SECRET,
    apiKey: { header: 'X-Api-Key', value: ACD_API_KEY },
  });
  routes.set('api.openai.com', openAi.server.origin);
  routes.set('streaming.assemblyai.com', stt.server.origin);
  routes.set('api.twilio.com', twilioRest.server.origin);
  routes.set(ACD_HOST, acd.server.origin);
  const stack = await startLiveStack(
    postgresUrl,
    {
      OVO_ROUTING_ENABLED: 'true',
      OVO_ROUTING_TRANSFER_ENABLED: 'true',
      OVO_ROUTING_PREPARE_TIMEOUT_MS: '6000',
      OVO_HUMAN_QUEUE_ENABLED: String(options.humanQueue ?? true),
      OVO_HUMAN_QUEUE_WEBHOOK_ENABLED: String(options.webhook ?? true),
      OVO_HUMAN_QUEUE_POLL_MS: '250',
      ...(options.room
        ? {
            OVO_LIVEKIT_ENABLED: 'true',
            OVO_LIVEKIT_URL: options.room.url,
            OVO_LIVEKIT_PUBLIC_URL: options.room.url,
            OVO_LIVEKIT_API_KEY: options.room.apiKey,
            OVO_LIVEKIT_API_SECRET: options.room.apiSecret,
          }
        : {}),
      ...options.variables,
    },
    { worker: options.workerVariables },
  );
  const agent = await configureInboundAgent(stack.operator);
  const line = await configureHumanLine(stack.operator, agent, options.line);
  await vi.waitFor(
    () => {
      if (stack.worker.status.state === 'failed') throw new Error(stack.worker.status.detail);
      expectReady(stack);
    },
    { timeout: 30_000, interval: 100 },
  );
  return {
    stack,
    agent,
    line,
    openAi,
    stt,
    twilioRest,
    acd,
    async close() {
      await stack.close();
      await Promise.all(
        [openAi, stt, twilioRest, acd].map((fake: { server: { close(): Promise<void> } }) =>
          fake.server.close(),
        ),
      );
    },
  };
}
export type HumanStack = Awaited<ReturnType<typeof humanStack>>;

function expectReady(stack: LiveStack) {
  if (stack.worker.status.state !== 'ready') throw new Error('worker not ready');
}

export { carrierUrls, type FakeAcd, type TransferOpenAi };
