import type { ToolDefinition } from '@winsendotai/ovo-contracts';
import type { EngineHarness, ScenarioSetup } from './engine-harness.ts';
import type { Failures } from './runner.ts';

export interface EngineScenario {
  name: string;
  setup: ScenarioSetup;
  run(harness: EngineHarness, f: Failures): Promise<void>;
}

export const FAQ = {
  mode: 'faq' as const,
  faq: [
    { id: 'hours', question: 'What are your opening hours?', answer: 'We are open nine to five.' },
  ],
};
export const LONG_ANSWER =
  'We are open from nine in the morning until five in the evening on every weekday except public holidays.';
export const tool = (id: string, effect: 'read' | 'write'): ToolDefinition => ({
  id,
  description: effect === 'write' ? 'Book a table' : 'Read the balance',
  connector: 'native',
  inputSchema: {
    type: 'object',
    required: effect === 'write' ? ['party'] : ['account'],
    properties:
      effect === 'write' ? { party: { type: 'integer' } } : { account: { type: 'string' } },
  },
  effect,
  confirmation: effect === 'write',
  timeoutMs: 5000,
});
export const BOOKING: ScenarioSetup = {
  agent: { mode: 'agent', tools: [tool('book_table', 'write')], allowedTools: ['book_table'] },
  replies: [
    { kind: 'tool', toolId: 'book_table', input: { party: 2 } },
    { kind: 'text', text: 'Your table is booked.' },
  ],
  tts: { msPerChar: 25 },
};
export const PROMPT = /confirm/i;

export const spoken = (h: EngineHarness, pattern: RegExp) =>
  h
    .events()
    .some((e) => e.type === 'agent.transcript' && e.state === 'generated' && pattern.test(e.text));
export const promptSent = (h: EngineHarness) => h.phases(PROMPT).some((p) => p.phase === 'sent');
export const respondSeq = (h: EngineHarness, input: RegExp) =>
  h.responds().find((r) => input.test(r.input))?.seq;
