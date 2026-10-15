import {
  RoutingReleaseSnapshot,
  type RoutingPointDraft,
  type RoutingPoolDefinition,
} from '../../../packages/contracts/src/index.ts';
import {
  PostgresOperationsService,
  routingSnapshotDigest,
} from '../../../packages/plugin-operations/src/index.ts';
import { operatorApi, type InboundAgent, type Operator } from './operator-setup.ts';
import type { LiveStack } from './stack.ts';

const TWILIO = '@winsendotai/ovo-carrier-twilio';

/** What each agent says first, so a test can tell from the synthesised speech who answered. */
export const LINES = {
  greeting: 'Welcome to Acme. How can I help you today?',
  ask: 'Are you calling to buy something new, or about an existing account?',
  salesEn: 'Hello, this is English sales.',
  salesHi: 'Namaste, this is Hindi sales.',
  support: 'Hello, this is support.',
  fallback: 'Hello, this is the front desk team.',
};

export interface RoutedAgent {
  agentId: string;
  releaseId: string;
}

export interface RoutedLine {
  router: RoutedAgent;
  fallback: RoutedAgent;
  salesEn: RoutedAgent;
  salesHi: RoutedAgent;
  support: RoutedAgent;
  routingReleaseId: string;
  routingPointId: string;
  salesPoolId: string;
  supportPoolId: string;
}

const pinned = ({ agentId, releaseId }: RoutedAgent) => ({
  agentId,
  release: { kind: 'pinned' as const, releaseId },
});

function pools(agents: Pick<RoutedLine, 'salesEn' | 'salesHi' | 'support'>) {
  const sales: RoutingPoolDefinition = {
    name: 'Sales',
    languageFallback: ['en'],
    members: [
      {
        id: 'sales-en',
        agent: pinned(agents.salesEn),
        languages: ['en'],
        products: [],
        skills: [],
        priority: 50,
        capacity: 2,
        enabled: true,
      },
      {
        id: 'sales-hi',
        agent: pinned(agents.salesHi),
        languages: ['hi'],
        products: [],
        skills: [],
        priority: 50,
        capacity: 2,
        enabled: true,
      },
    ],
  };
  const support: RoutingPoolDefinition = {
    name: 'Support',
    languageFallback: [],
    members: [
      {
        id: 'support',
        agent: pinned(agents.support),
        languages: ['en', 'hi'],
        products: [],
        skills: [],
        priority: 50,
        enabled: true,
      },
    ],
  };
  return { sales, support };
}

/**
 * The design's worked example cut to two pools: keypad 1/2 or the LLM classifier (with the
 * caller's language) at one node, a re-ask, then the release default, then a polite end.
 */
export function mainLineDraft(
  agents: Pick<RoutedLine, 'router' | 'fallback'>,
  salesPoolId: string,
  supportPoolId: string,
): RoutingPointDraft {
  return {
    name: 'Main line',
    router: pinned(agents.router),
    defaultTarget: pinned(agents.fallback),
    language: { default: 'en', allowed: ['en', 'hi'] },
    greeting: { en: LINES.greeting },
    root: 'intent',
    nodes: [
      {
        id: 'intent',
        sets: 'intent',
        ask: { en: LINES.ask },
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
            timeoutMs: 2_500,
            detectLanguage: true,
            generatedClarify: false,
          },
        ],
        branches: [
          {
            key: 'sales',
            description: 'Wants to buy, asks about prices, plans, new cards or loans',
            target: { kind: 'pool', poolId: salesPoolId, language: 'caller', skills: [] },
          },
          {
            key: 'support',
            description: 'Has a problem with an existing account, order or payment',
            target: { kind: 'pool', poolId: supportPoolId, language: 'any', skills: [] },
          },
        ],
        fallback: [
          { kind: 'reask', times: 1 },
          { kind: 'default' },
          { kind: 'end', line: { en: 'Sorry, I could not connect your call. Goodbye.' } },
        ],
        reuseTurn: true,
      },
    ],
    limits: { maxTurns: 6, maxRouteSeconds: 90 },
  };
}

/** Publishes four more agents beside the live-path one, each with an opening line. */
async function agents(operator: Operator, base: InboundAgent) {
  const call = operatorApi(operator);
  const agent = async (name: string, opening?: string): Promise<RoutedAgent> => {
    const created = await call<{ id: string }>('POST', '/v1/agents', {
      config: { ...base.config, name, ...(opening ? { opening: { lines: [opening] } } : {}) },
    });
    const release = await call<{ id: string }>('POST', `/v1/agents/${created.id}/releases`, {});
    return { agentId: created.id, releaseId: release.id };
  };
  return {
    router: await agent('Front desk'),
    fallback: await agent('Default desk', LINES.fallback),
    salesEn: await agent('Sales English', LINES.salesEn),
    salesHi: await agent('Sales Hindi', LINES.salesHi),
    support: await agent('Support', LINES.support),
  };
}

/** The operator path: pools, a point, a published routing release, and the number re-bound to it. */
export async function configureRoutedLine(
  operator: Operator,
  base: InboundAgent,
): Promise<RoutedLine> {
  const call = operatorApi(operator);
  const team = await agents(operator, base);
  const definitions = pools(team);
  const sales = await call<{ id: string }>('POST', '/v1/routing/pools', {
    definition: definitions.sales,
  });
  const support = await call<{ id: string }>('POST', '/v1/routing/pools', {
    definition: definitions.support,
  });
  const point = await call<{ id: string; draftVersion: number }>('POST', '/v1/routing/points', {
    draft: mainLineDraft(team, sales.id, support.id),
  });
  const release = await call<{ id: string }>('POST', `/v1/routing/points/${point.id}/releases`, {
    expectedDraftVersion: point.draftVersion,
  });
  await call('PUT', `/v1/operations/inbound/routes/${encodeURIComponent(base.number)}`, {
    expectedVersion: 1,
    routingReleaseId: release.id,
    variables: {},
    enabled: true,
    carrierPluginId: TWILIO,
    carrierBindingId: base.twilioBindingId,
  });
  return {
    ...team,
    routingReleaseId: release.id,
    routingPointId: point.id,
    salesPoolId: sales.id,
    supportPoolId: support.id,
  };
}

/**
 * The same line written straight to the operations database: the state a number is left in when
 * routing was on, the number was bound, and routing was then switched off (the API refuses
 * routing writes while it is off).
 */
export async function bindRoutedLineDirectly(
  operator: Operator,
  base: InboundAgent,
  db: LiveStack['db'],
  organizationId: string,
): Promise<RoutedLine> {
  const team = await agents(operator, base);
  const operations = new PostgresOperationsService({ pool: db, organizationId });
  const definitions = pools(team);
  const sales = await operations.routing.pools.create(definitions.sales);
  const support = await operations.routing.pools.create(definitions.support);
  const draft = mainLineDraft(team, sales.id, support.id);
  const point = await operations.routing.points.create(draft);
  const frozen = (pool: typeof sales) => ({
    id: pool.id,
    version: pool.version,
    name: pool.definition.name,
    languageFallback: pool.definition.languageFallback,
    members: pool.definition.members,
  });
  const snapshot = RoutingReleaseSnapshot.parse({
    ...draft,
    schemaVersion: 1,
    routingPointId: point.id,
    pools: { [sales.id]: frozen(sales), [support.id]: frozen(support) },
    releaseIds: [team.router, team.fallback, team.salesEn, team.salesHi, team.support].map(
      (agent) => agent.releaseId,
    ),
  });
  const release = await operations.routing.releases.create({
    pointId: point.id,
    draftVersion: point.draftVersion,
    snapshot,
    digest: routingSnapshotDigest(snapshot),
    createdBy: 'e2e:kill-switch',
  });
  await operations.inboundRoutes.put({
    phoneNumber: base.number,
    routingReleaseId: release!.id,
    variables: {},
    enabled: true,
    carrierPluginId: TWILIO,
    carrierBindingId: base.twilioBindingId,
    expectedVersion: 1,
  });
  return {
    ...team,
    routingReleaseId: release!.id,
    routingPointId: point.id,
    salesPoolId: sales.id,
    supportPoolId: support.id,
  };
}
