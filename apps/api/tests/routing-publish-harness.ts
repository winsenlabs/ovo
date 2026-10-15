/** Shared setup for the publish validation tests: a fake routing service over fixed releases. */
import {
  RoutingPointDraft,
  RoutingPoolDefinition,
  type CredentialMetadata,
  type RoutingIssue,
} from '@winsendotai/ovo-contracts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { validateRoutingDraft, type RoutingPublishContext } from '../src/routing-publish.ts';
import {
  draftInput,
  exampleReleases,
  fakeStore,
  FakeRoutingService,
  POOL_SALES,
  POOL_SUPPORT,
  poolInput,
  registry,
  release,
  ROUTER_RELEASE,
  WORKSPACE,
} from './routing-fixtures.ts';

const ENDPOINT = 'https://route.example.com/decide';
export const OTHER = '99999999-9999-4999-8999-999999999999';
export const BYE = { en: 'Goodbye.' };

export interface Setup {
  patch?: (draft: Record<string, any>) => void;
  releases?: ReleaseRecord[];
  credentials?: Partial<CredentialMetadata>[];
  pools?: 'none' | Record<string, [string, string[]][]>;
  languageFallback?: string[];
  externalEnabled?: boolean;
  requireCostPolicy?: boolean;
  deletedPools?: string[];
}

export async function context(setup: Setup = {}) {
  const routing = new FakeRoutingService();
  const pools = setup.pools ?? {
    [POOL_SALES]: [
      ['sales-en', ['en']],
      ['sales-hi', ['hi']],
    ],
    [POOL_SUPPORT]: [['support', ['en']]],
  };
  if (pools !== 'none')
    for (const [id, members] of Object.entries(pools))
      await routing.pools.create(
        RoutingPoolDefinition.parse({
          ...poolInput(`Pool ${id.slice(0, 2)}`, members),
          languageFallback: setup.languageFallback ?? [],
        }),
        id,
      );
  const input = draftInput();
  setup.patch?.(input);
  const draft = RoutingPointDraft.parse(input);
  const built: RoutingPublishContext = {
    workspaceId: WORKSPACE,
    store: fakeStore(setup.releases ?? exampleReleases(), setup.credentials) as never,
    routing: routing as never,
    pool: async (id) => (setup.deletedPools?.includes(id) ? 'deleted' : routing.pools.get(id)),
    registry,
    externalEnabled: setup.externalEnabled ?? true,
    requireCostPolicy: setup.requireCostPolicy ?? false,
  };
  return { context: built, draft, routing };
}

export async function issues(setup: Setup = {}): Promise<RoutingIssue[]> {
  const { context: built, draft } = await context(setup);
  return (await validateRoutingDraft(built, draft)).issues;
}
export const codes = (found: RoutingIssue[]) => found.map((issue) => [issue.code, issue.severity]);
export const withRouter = (patch: Parameters<typeof release>[2]) => [
  release(ROUTER_RELEASE, 'front-desk', patch),
  ...exampleReleases().slice(1),
];
export const externalEngine =
  (extra: Record<string, unknown> = {}) =>
  (draft: Record<string, any>) =>
    draft.nodes[0].engines.push({
      kind: 'external',
      endpoint: ENDPOINT,
      credentialId: 'route-secret',
      ...extra,
    });
