import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import {
  RoutingPoolDefinition,
  canonicalJson,
  type PoolConsideration,
  type RoutingEvalCase,
  type RoutingRelease,
  type RoutingScorecard,
} from '@winsendotai/ovo-contracts';
import type {
  ExplainInput,
  RoutingSimulator,
  ScorerInput,
  SimulationRun,
  SimulatorInput,
} from '../src/routing-simulator.ts';
import { POOL_SALES, POOL_SUPPORT, draftInput, poolInput, routingApp } from './routing-fixtures.ts';

/** What a scripted simulator was asked, for the routes' tests to read back. */
export interface SimulatorCalls {
  simulate: SimulatorInput[];
  explain: ExplainInput[];
  score: ScorerInput[];
}

const rate = (correct: number, total: number) => ({
  correct,
  total,
  rate: total ? correct / total : null,
});
const tally = {
  attempts: 0,
  matched: 0,
  no_match: 0,
  low_confidence: 0,
  timeout: 0,
  error: 0,
  disabled: 0,
};

/** A scorecard the way the scorer returns one, for `cases` cases of which `passed` pass. */
export function scorecardFor(cases: number, passed: number): RoutingScorecard {
  return {
    schema: 'ovo.routing-scorecard/1',
    engineMode: 'recorded',
    corpus: { name: 'scripted', digest: 'a'.repeat(64), cases },
    routing: { pointId: null, routingReleaseId: null, digest: 'b'.repeat(64) },
    totals: { cases, passed, failed: cases - passed },
    accuracy: {
      overall: rate(passed, cases),
      status: rate(passed, cases),
      path: rate(0, 0),
      node: rate(0, 0),
      branch: rate(0, 0),
      pool: rate(0, 0),
      member: rate(0, 0),
      agent: rate(0, 0),
      queue: rate(0, 0),
      language: rate(0, 0),
    },
    fallbackRate: { ...rate(0, cases), byStep: {} },
    clarifyRate: rate(0, cases),
    endRate: rate(0, cases),
    perEngine: { rules: tally, decision: tally, llm: tally, external: tally, context: tally },
    confusion: {},
    calibration: [],
    perNode: [],
    byTag: {},
    failures: [],
    ms: { total: 1, p50: 1, p95: 1 },
  };
}

/**
 * A simulator that answers a fixed route and records what it was given. The routes' own logic
 * (target resolution, flags, load, roles, audit, limits) is what the tests exercise; the router
 * itself is tested in `plugin-router`, and the parity test runs the two together.
 */
export function scriptedSimulator(
  overrides: Partial<RoutingSimulator> = {},
): RoutingSimulator & { calls: SimulatorCalls } {
  const calls: SimulatorCalls = { simulate: [], explain: [], score: [] };
  return {
    calls,
    async simulateRoute(input): Promise<SimulationRun> {
      calls.simulate.push(input);
      const mode = input.request.engines.mode;
      return {
        at: new Date(
          input.request.call.at ? Date.parse(input.request.call.at) : input.now,
        ).toISOString(),
        turns: [
          {
            index: 0,
            input: { kind: 'opening' },
            say: 'Welcome.',
            phase: 'routing',
            virtualMs: 0,
            steps: [],
          },
          ...input.request.turns.map((turn, index) => ({
            index: index + 1,
            input: turn,
            say: 'Connecting you now.',
            phase: 'announcing' as const,
            virtualMs: (index + 1) * 3_000,
            steps: [],
          })),
        ],
        outcome: {
          status: 'agent',
          completionReason: 'route:agent:intent>sales',
          node: 'intent',
          path: ['intent'],
          language: 'en',
          context: { intent: 'sales' },
          turns: input.request.turns.length,
          routeMs: input.request.turns.length * 3_000,
          line: 'Connecting you now.',
          degraded: null,
          agent: { agentId: 'sales-en', releaseId: input.snapshot.defaultTarget.release.releaseId },
          targetVariables: { ovo_route_intent: 'sales' },
          human: null,
          callback: null,
          endDisposition: null,
        },
        pools: [],
        warnings: [],
        stats: {
          ms: 1,
          virtualMs: input.request.turns.length * 3_000,
          routerTurns: input.request.turns.length + 1,
          liveCalls: input.live ? 1 : 0,
        },
        assumed: input.flags,
        engineModes: {
          rules: 'real',
          decision: mode.decision,
          llm: mode.llm,
          external: mode.external,
        },
      };
    },
    explainPool(input) {
      calls.explain.push(input);
      return {
        poolId: input.pool.id,
        poolName: input.pool.name,
        wanted: {
          language: input.context.language ?? input.defaultLanguage,
          languageMode: input.target.language,
          products: null,
          skills: input.target.skills,
        },
        languageUsed: input.context.language ?? input.defaultLanguage,
        members: input.pool.members.map((member, index) => ({
          memberId: member.id,
          agentId: member.agent.agentId,
          releaseId: member.agent.release.releaseId,
          priority: member.priority,
          enabled: member.enabled,
          open: null,
          productOk: true,
          skillsOk: true,
          languageOk: member.languages.includes(input.context.language ?? input.defaultLanguage),
          eligible: true,
          tier: 0,
          active: input.load?.[member.id] ?? 0,
          capacity: member.capacity ?? null,
          full: false,
          picked: index === 0,
          reasons: [],
        })),
        result: 'picked',
      } satisfies Omit<PoolConsideration, 'turn' | 'node'>;
    },
    async scoreRoutingCorpus(input) {
      calls.score.push(input);
      return {
        ...scorecardFor(input.cases.length, Math.max(input.cases.length - 1, 0)),
        corpus: {
          name: input.name,
          digest: this.routingCorpusDigest(input.cases),
          cases: input.cases.length,
        },
      };
    },
    routingCorpusDigest: (cases: readonly RoutingEvalCase[]) =>
      createHash('sha256').update(canonicalJson(cases)).digest('hex'),
    ...overrides,
  };
}

export const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

type Options = Parameters<typeof routingApp>[0];

/** The routing routes over the fake service, with the worked example's pools seeded. */
export async function r4Setup(options: Options = {}) {
  const built = routingApp(options);
  apps.push(built.app);
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => built.app.inject({ method, url, payload: payload as never, headers });
  const definition = (name: string, members: [string, string[]][]) =>
    RoutingPoolDefinition.parse(poolInput(name, members));
  await built.routing.pools.create(
    definition('Sales', [
      ['sales-en', ['en']],
      ['sales-hi', ['hi']],
    ]),
    POOL_SALES,
  );
  await built.routing.pools.create(definition('Support', [['support', ['en']]]), POOL_SUPPORT);
  return { ...built, call };
}

type Call = Awaited<ReturnType<typeof r4Setup>>['call'];

/** A point from the worked draft and its published release. */
export async function publishPoint(call: Call, draft = draftInput()) {
  const point = (await call('POST', '/v1/routing/points', { draft })).json();
  const released = await call('POST', `/v1/routing/points/${point.id}/releases`, {});
  if (released.statusCode !== 201) throw new Error(`publish failed: ${released.body}`);
  return { point, release: released.json() as RoutingRelease };
}
