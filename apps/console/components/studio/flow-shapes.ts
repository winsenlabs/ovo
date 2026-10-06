import { AgentFlow, inspectFlow, type FlowIssue } from '@winsendotai/ovo-contracts';
import type { AgentConfig } from '../../lib/api';

/** The authored flow as the draft stores it: parsed, so every default is filled in. */
export type Flow = NonNullable<NonNullable<AgentConfig['decision']>['flow']>;

/**
 * A two-state flow that is valid the moment it appears: a greeting that listens, and a goodbye.
 * The draft is saved on each edit, so starter content has to pass the shared contract untouched.
 */
export const starterFlow = (): Flow =>
  AgentFlow.parse({
    start: 'greet',
    lines: {
      greeting: 'Hello, this is your assistant. How can I help you today?',
      goodbye: 'Thank you for your time. Goodbye.',
    },
    nodes: [
      { id: 'greet', say: ['greeting'], listen: 'open' },
      { id: 'goodbye', say: ['goodbye'], end: true },
    ],
    listens: [
      {
        id: 'open',
        question: 'The agent greeted the caller. What does `caller_reply` want?',
        intents: [
          {
            key: 'done',
            description: 'They have nothing more to discuss',
            phrases: ['no thanks', 'bye'],
            next: 'goodbye',
          },
        ],
      },
    ],
  });

/** Parse pasted JSON into a flow, or say in one line why it cannot be one. */
export function importFlow(source: string): { flow: Flow } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { error: 'Enter valid JSON.' };
  }
  const parsed = AgentFlow.safeParse(raw);
  if (parsed.success) return { flow: parsed.data };
  const first = parsed.error.issues[0]!;
  return { error: `${first.path.join('.') || 'flow'}: ${first.message}` };
}

/** Graph issues, errors first, as the release check will report them. */
export function flowIssues(flow: Flow): FlowIssue[] {
  return inspectFlow(flow).sort(
    (left, right) => Number(left.severity === 'warning') - Number(right.severity === 'warning'),
  );
}

/** Where an intent leads, in words, for the read-only map. */
export function describeRoute(intent: Flow['globalIntents'][number]): string {
  if (intent.repeat) return 'repeats the last lines';
  const next = intent.next;
  if (next === undefined) return 'goes nowhere';
  if (typeof next === 'string') return `→ ${next}`;
  const cases = Object.entries(next.cases).map(([value, node]) => `${value} → ${node}`);
  return `by ${next.slot}: ${[...cases, `otherwise → ${next.otherwise}`].join(', ')}`;
}
