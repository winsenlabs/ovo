import {
  AgentConfig,
  type DecisionAnswer,
  type DecisionPort,
  type DecisionRequest,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { execution, llm, NOW, variables } from './agent-call-control-fixture.ts';

/** A collections policy where every outcome speaks: the shape a Jev-only agent is authored in. */
export const policy = (fallback: 'clarify' | 'llm' = 'clarify') => ({
  enabled: true,
  questions: [
    {
      type: 'choice',
      id: 'intent',
      instructions: 'What does the caller want?',
      threshold: 0.8,
      fallback,
      options: [
        { key: 'pay', description: 'Will pay', outcome: { say: 'Thank you, {{name}}.' } },
        { key: 'bye', description: 'Wants to go', outcome: { say: 'Goodbye.', end: true } },
        { key: 'other', description: 'Anything else', outcome: { say: 'Let me note that.' } },
      ],
    },
  ],
  state: { sources: ['last-turn'] },
});

/** A decision port scripted per call: a choice and its confidence, or a thrown error. */
export function jev(...answers: ([string, number] | Error)[]) {
  const seen: DecisionRequest[] = [];
  const port: DecisionPort = {
    decide: async (request) => {
      seen.push(request);
      const next = answers.shift() ?? new Error('no scripted answer');
      if (next instanceof Error) throw next;
      const [choice, confidence] = next;
      return {
        modelId: 'jev-1',
        answers: {
          intent: {
            type: 'choice',
            choice,
            confidence,
            calibrationVersion: 'jev-1/a',
            // Valid only when the choice is the most likely: the rest is split evenly.
            probabilities: Object.fromEntries(
              ['pay', 'bye', 'other'].map((key) => [
                key,
                key === choice ? confidence : (1 - confidence) / 2,
              ]),
            ),
          } as DecisionAnswer,
        },
      };
    },
  };
  return { port, seen };
}

/** An agent with the given decision port and, unless `llm` is passed, no LLM at all (AGT-4). */
export function jevOnly(
  over: Record<string, unknown>,
  decision: DecisionPort,
  model?: ReturnType<typeof llm>,
) {
  return new AgentBehavior(
    AgentConfig.parse({ name: 'Collections', mode: 'agent', variables, ...over }),
    model?.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', now: () => NOW, decision },
  );
}
