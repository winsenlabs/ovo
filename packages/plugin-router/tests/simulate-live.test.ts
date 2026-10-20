import type {
  DecisionPort,
  ExternalDecisionResponse,
  Inference,
  InferenceReply,
  RoutingHost,
} from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { ROUTE_QUESTION_ID } from '../src/engines/index.ts';
import { SimulationInputError } from '../src/simulate/index.ts';
import { exampleRoutingSnapshot } from '../src/testing.ts';
import { nodeSteps, simulate, speech, trace } from './support-sim.ts';

const live = (engines: Record<string, 'live' | 'mock'>) => ({ engines: { mode: engines } });

function inference(reply: () => Promise<InferenceReply>): Inference & { asked: number } {
  const port = {
    model: 'fake-router-model',
    asked: 0,
    generate: () => {
      port.asked += 1;
      return reply();
    },
  };
  return port;
}
const tool = (input: unknown): InferenceReply => ({ kind: 'tool', toolId: 'ovo_route', input });

describe('simulateRoute: live engines', () => {
  it('runs the LLM classifier through the supplied inference port and reports it live', async () => {
    const port = inference(async () => tool({ branch: 'sales', confidence: 0.9, language: 'hi' }));
    const run = await simulate(
      exampleRoutingSnapshot(),
      { ...live({ llm: 'live' }), turns: [speech('mujhe naya card chahiye')] },
      { live: { inference: port } },
    );
    expect(port.asked).toBe(1);
    expect(run.engineModes).toEqual({
      rules: 'real',
      decision: 'mock',
      llm: 'live',
      external: 'mock',
    });
    expect(run.turns[1]!.steps[1]).toMatchObject({
      type: 'route.node',
      mocked: false,
      payload: { engine: 'llm', outcome: 'matched', branch: 'sales', modelId: 'fake-router-model' },
    });
    expect(run.outcome).toMatchObject({
      status: 'agent',
      language: 'hi',
      agent: { memberId: 'sales-hi' },
    });
    expect(run.stats).toMatchObject({ liveCalls: 1 });
    expect(run.stats.ms).toBeGreaterThanOrEqual(0);
    expect(run.warnings.map((w) => w.code)).toEqual(['live_engine_used']);
  });

  it('records a failing live engine as the real error and lets the chain move on', async () => {
    const port = inference(async () => {
      throw new Error('upstream 503');
    });
    const run = await simulate(
      exampleRoutingSnapshot(),
      { ...live({ llm: 'live' }), turns: [speech('card')] },
      { live: { inference: port } },
    );
    expect(trace(run)).toContain('node:intent:llm:error');
    expect(nodeSteps(run).find((s) => s.engine === 'llm')).toMatchObject({ reason: 'llm_failed' });
    expect(run.turns[1]!.phase).toBe('routing');
  });

  it('keeps the other engines scripted while one is live', async () => {
    const port = inference(async () => tool({ branch: 'support', confidence: 0.2 }));
    const run = await simulate(
      exampleRoutingSnapshot(),
      {
        ...live({ llm: 'live' }),
        turns: [speech('card')],
        engines: {
          mode: { llm: 'live' },
          answers: [{ node: 'intent', engine: 'decision', branch: 'sales' }],
        },
      },
      { live: { inference: port } },
    );
    expect(trace(run)).toContain('node:intent:llm:low_confidence>support');
  });

  it('runs a decision engine through the supplied decision port', async () => {
    const decision: DecisionPort = {
      decide: async () =>
        ({
          modelId: 'fake-jev',
          answers: {
            [ROUTE_QUESTION_ID]: {
              type: 'choice',
              choice: 'support',
              confidence: 0.95,
              calibrationVersion: 'fake/cohort',
              probabilities: { sales: 0.05, support: 0.95 },
            },
          },
        }) as never,
    };
    const snapshot = exampleRoutingSnapshot((raw) => {
      raw.nodes[0].engines = [{ kind: 'decision', instructions: 'Why is the caller calling?' }];
    });
    const run = await simulate(
      snapshot,
      { ...live({ decision: 'live' }), turns: [speech('my card is blocked')] },
      { live: { decision } },
    );
    expect(trace(run)).toContain('node:intent:decision:matched>support');
    expect(run.engineModes.decision).toBe('live');
    expect(run.outcome.path).toEqual(['intent', 'product']);
  });

  it('runs an external engine through the supplied transport', async () => {
    const asked: Parameters<RoutingHost['external']>[0][] = [];
    const external: RoutingHost['external'] = async (input): Promise<ExternalDecisionResponse> => {
      asked.push(input);
      return { branch: 'sales', confidence: 0.8, slots: {} };
    };
    const snapshot = exampleRoutingSnapshot((raw) => {
      raw.nodes[0].engines = [
        { kind: 'external', endpoint: 'https://router.example.com/decide', credentialId: 'cred-1' },
      ];
    });
    const run = await simulate(
      snapshot,
      { ...live({ external: 'live' }), turns: [speech('card')] },
      { live: { external } },
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ node: 'intent', branches: ['sales', 'support'] });
    expect(trace(run)).toContain('node:intent:external:matched>sales');
    expect(run.turns[1]!.steps[0]).toMatchObject({ mocked: false });
  });

  it('refuses a live engine nobody supplied, rather than quietly mocking it', async () => {
    for (const engine of ['decision', 'llm', 'external'] as const)
      await expect(
        simulate(exampleRoutingSnapshot(), { ...live({ [engine]: 'live' }), turns: [speech('a')] }),
      ).rejects.toMatchObject({ name: 'SimulationInputError', code: 'live_engine_unavailable' });
  });

  it('allows a live run only a handful of caller turns', async () => {
    const port = inference(async () => tool({ branch: null, confidence: 0 }));
    const turns = Array.from({ length: 9 }, () => speech('hello'));
    await expect(
      simulate(
        exampleRoutingSnapshot(),
        { ...live({ llm: 'live' }), turns },
        { live: { inference: port } },
      ),
    ).rejects.toBeInstanceOf(SimulationInputError);
    expect(port.asked).toBe(0);
  });
});
