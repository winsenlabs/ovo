import { RoutingPointDraft, RoutingReleaseSnapshot } from '../src/index.ts';

export const POOL_SALES = '11111111-1111-4111-8111-111111111111';
export const POOL_SUPPORT = '22222222-2222-4222-8222-222222222222';
export const POINT_ID = '33333333-3333-4333-8333-333333333333';
export const ROUTER_RELEASE = '44444444-4444-4444-8444-444444444444';
export const DEFAULT_RELEASE = '55555555-5555-4555-8555-555555555555';
export const SALES_EN_RELEASE = '66666666-6666-4666-8666-666666666666';
export const SALES_HI_RELEASE = '77777777-7777-4777-8777-777777777777';
export const SUPPORT_RELEASE = '88888888-8888-4888-8888-888888888888';

/** The design's worked example (section 20), cut down to two pools: a valid draft input. */
export function draftInput(): Record<string, unknown> {
  return {
    name: 'Main line',
    router: { agentId: 'front-desk', release: { kind: 'latest' } },
    defaultTarget: { agentId: 'sales-en', release: { kind: 'latest' } },
    language: { default: 'en', allowed: ['en', 'hi'] },
    greeting: { en: 'Welcome to Acme. How can I help you today?', hi: 'Acme में आपका स्वागत है।' },
    root: 'intent',
    nodes: [
      {
        id: 'intent',
        sets: 'intent',
        ask: { en: 'Are you calling to buy something, or about an existing account?' },
        engines: [
          {
            kind: 'rules',
            rules: [
              { branch: 'sales', when: [{ kind: 'dtmf', digits: '1' }] },
              { branch: 'support', when: [{ kind: 'dtmf', digits: '2' }] },
            ],
          },
          { kind: 'llm', instructions: 'Decide why the caller is calling.', detectLanguage: true },
        ],
        branches: [
          {
            key: 'sales',
            description: 'Wants to buy, asks about prices, plans, new cards or loans',
            target: { kind: 'pool', poolId: POOL_SALES, language: 'caller' },
          },
          {
            key: 'support',
            description: 'Has a problem with an existing account, order or payment',
            target: { kind: 'pool', poolId: POOL_SUPPORT },
          },
        ],
        fallback: [
          { kind: 'reask', times: 1 },
          { kind: 'default' },
          { kind: 'end', line: { en: 'Sorry, I could not connect your call. Goodbye.' } },
        ],
      },
    ],
  };
}

export function draft(patch: (input: Record<string, any>) => void = () => {}): RoutingPointDraft {
  const input = draftInput();
  patch(input);
  return RoutingPointDraft.parse(input);
}

function pool(id: string, members: [string, string, string[]][]) {
  return {
    id,
    version: 1,
    name: id === POOL_SALES ? 'Sales' : 'Support',
    languageFallback: ['en'],
    members: members.map(([member, releaseId, languages]) => ({
      id: member,
      agent: { agentId: member, release: { kind: 'pinned', releaseId } },
      languages,
    })),
  };
}

/** A valid release snapshot input built from `draftInput()`. */
export function snapshotInput(): Record<string, any> {
  return {
    ...draftInput(),
    schemaVersion: 1,
    routingPointId: POINT_ID,
    router: { agentId: 'front-desk', release: { kind: 'pinned', releaseId: ROUTER_RELEASE } },
    defaultTarget: { agentId: 'sales-en', release: { kind: 'pinned', releaseId: DEFAULT_RELEASE } },
    pools: {
      [POOL_SALES]: pool(POOL_SALES, [
        ['sales-en', SALES_EN_RELEASE, ['en']],
        ['sales-hi', SALES_HI_RELEASE, ['hi']],
      ]),
      [POOL_SUPPORT]: pool(POOL_SUPPORT, [['support', SUPPORT_RELEASE, ['en', 'hi']]]),
    },
    releaseIds: [
      ROUTER_RELEASE,
      DEFAULT_RELEASE,
      SALES_EN_RELEASE,
      SALES_HI_RELEASE,
      SUPPORT_RELEASE,
    ],
  };
}

export function snapshot(): RoutingReleaseSnapshot {
  return RoutingReleaseSnapshot.parse(snapshotInput());
}
