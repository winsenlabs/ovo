import type { DecisionPort, DecisionRequest } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  createDecisionRunner,
  routeDecisionRequest,
  ROUTE_QUESTION_ID,
} from '../src/engines/index.ts';
import { engineInput, engineNode, engineOf, forever, untilAborted } from './support.ts';

const node = engineNode([
  { kind: 'decision', instructions: 'Why is the caller calling?', threshold: 0.7, timeoutMs: 100 },
]);
const engine = engineOf(node, 'decision');
const turn = { text: 'my card was blocked' };

function choice(chosen: string, confidence: number, probabilities: Record<string, number>) {
  return {
    modelId: 'jev-test',
    answers: {
      [ROUTE_QUESTION_ID]: {
        type: 'choice',
        choice: chosen,
        confidence,
        calibrationVersion: 'jev-test/cohort',
        probabilities,
      },
    },
  };
}

/** A scripted DecisionPort: answers with `reply`, recording what it was asked. */
function port(reply: (request: DecisionRequest, signal: AbortSignal) => Promise<unknown>) {
  const asked: DecisionRequest[] = [];
  const decision: DecisionPort = {
    decide: (request, { signal }) => {
      asked.push(request);
      return reply(request, signal) as never;
    },
  };
  return { asked, decision };
}

describe('decision engine', () => {
  it('asks one choice question whose criteria are the branch descriptions', () => {
    const transcript = [
      { role: 'router' as const, text: 'How can I help?' },
      { role: 'caller' as const, text: 'hello' },
    ];
    expect(routeDecisionRequest(engine, engineInput(node, turn, { transcript }))).toEqual({
      state: {
        'last-caller-turn': 'my card was blocked',
        'router-transcript': ['router: How can I help?', 'caller: hello'],
      },
      questions: {
        route: {
          type: 'choice',
          instructions: 'Why is the caller calling?',
          criteria: { sales: 'The caller wants sales', support: 'The caller wants support' },
        },
      },
    });
  });

  it('matches a confident choice', async () => {
    const { decision, asked } = port(async () =>
      choice('support', 0.9, { sales: 0.1, support: 0.9 }),
    );
    await expect(createDecisionRunner(decision)(engine, engineInput(node, turn))).resolves.toEqual({
      outcome: 'matched',
      branch: 'support',
      confidence: 0.9,
      modelId: 'jev-test',
    });
    expect(asked).toHaveLength(1);
  });

  it('reports a choice under the threshold as low confidence', async () => {
    const { decision } = port(async () => choice('support', 0.55, { sales: 0.45, support: 0.55 }));
    await expect(createDecisionRunner(decision)(engine, engineInput(node, turn))).resolves.toEqual({
      outcome: 'low_confidence',
      branch: 'support',
      confidence: 0.55,
      modelId: 'jev-test',
    });
  });

  it.each([
    ['a choice that is not the most probable', choice('sales', 0.9, { sales: 0.2, support: 0.8 })],
    ['probabilities that miss a branch', choice('sales', 0.9, { sales: 1 })],
    [
      'answers to another question',
      {
        modelId: 'm',
        answers: { other: choice('sales', 1, { sales: 1, support: 0 }).answers.route },
      },
    ],
    ['a body that is not a decision response', { nope: true }],
  ])('reports %s as an incoherent error', async (_name, body) => {
    const { decision } = port(async () => body);
    await expect(
      createDecisionRunner(decision)(engine, engineInput(node, turn)),
    ).resolves.toMatchObject({
      outcome: 'error',
      reason: 'incoherent',
    });
  });

  it('times out at its deadline, whether or not the port honours the signal', async () => {
    const honours = port((_request, signal) => untilAborted(signal));
    const ignores = port(() => forever());
    for (const { decision } of [honours, ignores])
      await expect(
        createDecisionRunner(decision)(engine, engineInput(node, turn)),
      ).resolves.toEqual({
        outcome: 'timeout',
      });
  });

  it('reports a port failure as an error', async () => {
    const { decision } = port(async () => {
      throw new Error('503');
    });
    await expect(createDecisionRunner(decision)(engine, engineInput(node, turn))).resolves.toEqual({
      outcome: 'error',
      reason: 'decision_failed',
    });
  });

  it('is disabled when no decision plugin is selected', async () => {
    await expect(createDecisionRunner(undefined)(engine, engineInput(node, turn))).resolves.toEqual(
      {
        outcome: 'disabled',
        reason: 'decision_unavailable',
      },
    );
  });

  it('does not ask about an empty turn or a one-branch node', async () => {
    const { decision, asked } = port(async () => choice('sales', 1, { sales: 1, support: 0 }));
    const run = createDecisionRunner(decision);
    await expect(run(engine, engineInput(node, { text: '  ' }))).resolves.toMatchObject({
      outcome: 'no_match',
    });
    const single = engineNode([{ kind: 'decision', instructions: 'x' }], ['sales']);
    await expect(
      run(engineOf(single, 'decision'), engineInput(single, turn)),
    ).resolves.toMatchObject({
      outcome: 'error',
      reason: 'single_branch',
    });
    expect(asked).toHaveLength(0);
  });

  it('passes a cancelled turn up instead of recording it', async () => {
    const controller = new AbortController();
    const { decision } = port((_request, signal) => untilAborted(signal));
    const running = createDecisionRunner(decision)(
      engine,
      engineInput(node, turn, { signal: controller.signal }),
    );
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(running).rejects.toThrow('cancelled');
  });
});
