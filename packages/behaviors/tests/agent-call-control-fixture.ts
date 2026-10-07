import {
  AgentConfig,
  type DecisionAnswer,
  type DecisionPort,
  type DecisionRequest,
  type Execution,
  type Inference,
  type InferenceReply,
  type InferenceRequest,
  type InferenceStreamEvent,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';

// Tuesday 6 October 2026, 23:30 UTC: already Wednesday the 7th in Asia/Kolkata.
export const NOW = new Date('2026-10-06T23:30:00Z');

export const variables = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    amount_due: { type: 'number', 'x-ovo-format': 'currency', 'x-ovo-currency': 'INR' },
  },
  additionalProperties: false,
};
export const call = { name: 'Ravi', amount_due: 12500 };

export const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };

export function llm(replies: (InferenceReply | InferenceStreamEvent[])[] = []) {
  const requests: InferenceRequest[] = [];
  const next = () => replies.shift() ?? { kind: 'text' as const, text: 'A composed LLM answer.' };
  const port: Inference = {
    generate: async (request) => {
      requests.push(request);
      return next() as InferenceReply;
    },
    async *stream(request) {
      requests.push(request);
      const reply = next();
      if (Array.isArray(reply)) yield* reply;
      else if (reply.kind === 'text') yield { kind: 'text-delta', delta: reply.text };
      else yield { kind: 'tool', toolId: reply.toolId, input: reply.input };
    },
  };
  return { port, requests };
}

export function agent(
  over: Record<string, unknown> = {},
  options: { llm?: ReturnType<typeof llm>; decision?: DecisionPort } = {},
) {
  const model = options.llm ?? llm();
  const behavior = new AgentBehavior(
    AgentConfig.parse({ name: 'Collections', mode: 'agent', variables, ...over }),
    model.port,
    execution,
    {
      workspaceId: 'w-1',
      sessionId: 's-1',
      now: () => NOW,
      ...(options.decision ? { decision: options.decision } : {}),
    },
  );
  return { behavior, model };
}

export function receipt(text: string, epoch: number, state: SpeechReceipt['state'] = 'completed') {
  return { id: `${epoch}:${text}`, text, epoch, state, evidence: 'confirmed' as const };
}

export async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const segment of stream) out.push(segment);
  return out;
}

export const goodbye = (outcome: Record<string, unknown>) => ({
  enabled: true,
  // LAT-3 (the LLM asked alongside the decision) is on by default; these tests count LLM calls.
  speculation: { llm: false },
  questions: [
    {
      type: 'choice',
      id: 'intent',
      instructions: 'What does the caller want?',
      threshold: 0.8,
      fallback: 'clarify',
      options: [
        { key: 'bye', description: 'Wants to end the call', outcome },
        { key: 'other', description: 'Anything else', outcome: {} },
      ],
    },
  ],
  state: { sources: ['last-turn'] },
});

export function decides(
  choice: string,
  confidence = 0.95,
  seen: DecisionRequest[] = [],
): DecisionPort {
  return {
    decide: async (request) => {
      seen.push(request);
      return {
        modelId: 'jev-1',
        answers: {
          intent: {
            type: 'choice',
            choice,
            confidence,
            calibrationVersion: 'jev-1/a',
            probabilities: { bye: confidence, other: 1 - confidence },
          } as DecisionAnswer,
        },
      };
    },
  };
}
