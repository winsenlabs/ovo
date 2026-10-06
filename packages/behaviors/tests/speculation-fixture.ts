import {
  AgentConfig,
  normalizeForMatch,
  type DecisionPort,
  type DecisionRequest,
  type DecisionResponse,
  type Execution,
  type Inference,
  type InferenceRequest,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior, type SpeculationPolicy } from '../src/index.ts';
import { answerFor, collectionsFlow, type Scripted } from './flow-fixture.ts';

export const JEV_MS = 300;
export const LLM_MS = 500;

export const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };
export const variables = {
  type: 'object',
  properties: { full_name: { type: 'string' }, emi: { type: 'string' } },
  additionalProperties: false,
};
export const call = { full_name: 'Ravi Kumar', emi: 'four thousand rupees' };

/** Resolves after `ms` of (fake) time, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Moves the test's fake clock (`vi.advanceTimersByTimeAsync`); fixtures may not import vitest. */
export type Advance = (ms: number) => Promise<unknown>;

/** How long `promise` takes to settle on the fake clock, stepping it 5ms at a time. */
export async function settleMs(promise: Promise<unknown>, advance: Advance): Promise<number> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  const start = Date.now();
  await advance(0);
  while (!settled) await advance(5);
  return Date.now() - start;
}

/**
 * A decision model that takes `JEV_MS` per round trip and answers by the caller's words (a flow's
 * `caller_reply`, a flat policy's `lastCallerTurn`), recording each request and how many overlap.
 */
export function slowJev(
  answers: Record<string, Scripted | DecisionResponse | Error>,
  respond: (request: DecisionRequest, scripted: Scripted) => DecisionResponse = answerFor,
) {
  const requests: DecisionRequest[] = [];
  const signals: AbortSignal[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const port: DecisionPort = {
    decide: async (request, options) => {
      requests.push(request);
      signals.push(options.signal);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await sleep(JEV_MS, options.signal);
        const state = request.state as Record<string, unknown>;
        const words = String(state['caller_reply'] ?? state['lastCallerTurn'] ?? '');
        const answer = answers[normalizeForMatch(words)] ?? { intent: 'other' };
        if (answer instanceof Error) throw answer;
        return 'answers' in answer ? answer : respond(request, answer);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { port, requests, signals, maxInFlight: () => maxInFlight };
}

/** An LLM whose first text arrives `LLM_MS` after it is asked, recording requests and aborts. */
export function slowLlm(text = 'A composed LLM answer.') {
  const requests: InferenceRequest[] = [];
  const port: Inference = {
    generate: async (request) => {
      requests.push(request);
      await sleep(LLM_MS, request.signal);
      return { kind: 'text', text };
    },
    async *stream(request) {
      requests.push(request);
      await sleep(LLM_MS, request.signal);
      yield { kind: 'text-delta', delta: text };
      yield { kind: 'finish' };
    },
  };
  return { port, requests };
}

export function flowAgent(
  jev: DecisionPort,
  speculation: Partial<SpeculationPolicy> = {},
  options: { llm?: Inference; flow?: ReturnType<typeof collectionsFlow> } = {},
) {
  return new AgentBehavior(
    AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      variables,
      decision: { enabled: true, flow: options.flow ?? collectionsFlow() },
    }),
    options.llm,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', decision: jev, speculation },
  );
}

/** Greets, then confirms identity by phrase: the call now listens for when they will pay. */
export async function atPayment(agent: AgentBehavior): Promise<void> {
  await agent.respond('', { inputEvent: 'opening', ...call });
  await agent.respond('yes', call);
}

/** The first segment a streamed turn yields, and how long it took on the fake clock. */
export async function firstSegment(agent: AgentBehavior, text: string, advance: Advance) {
  const iterator = agent.respondStream(text, call)[Symbol.asyncIterator]();
  const first = iterator.next();
  const ms = await settleMs(first, advance);
  const segment = (await first).value as string;
  // Drain the rest so the turn finishes and commits.
  for (;;) {
    const next = iterator.next();
    await settleMs(next, advance);
    if ((await next).done) break;
  }
  return { ms, segment };
}
