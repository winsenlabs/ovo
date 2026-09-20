import type { EvaluationCase } from '../types.ts';

const confirmation = (state: string) =>
  `Please confirm: Update account state. Details: {"state":"${state}"}. Say yes to proceed or no to cancel.`;

export const agentCases: EvaluationCase[] = [
  ...Array.from({ length: 10 }, (_, index): EvaluationCase => ({
    id: `agent-text-${index + 1}`,
    mode: 'agent',
    title: `Returns bounded fixture model text ${index + 1}`,
    tags: ['mock-model', 'no-tool'],
    turns: [{ input: `Question ${index + 1}` }],
    expected: { outputs: [`Fixture answer ${index + 1}`], operationCount: 0 },
    fixture: { inference: [{ kind: 'text', text: `Fixture answer ${index + 1}` }] },
  })),
  ...Array.from({ length: 5 }, (_, index): EvaluationCase => ({
    id: `agent-read-${index + 1}`,
    mode: 'agent',
    title: `Executes approved read through shared execution ${index + 1}`,
    tags: ['tool', 'read', 'shared-execution'],
    turns: [{ input: 'Look up the account' }],
    expected: {
      outputs: ['The fixture account is active.'],
      operationCount: 1,
      operationStates: ['succeeded'],
    },
    fixture: {
      inference: [
        { kind: 'tool', toolId: 'lookup', input: { account: `A-${index + 1}` } },
        { kind: 'text', text: 'The fixture account is active.' },
      ],
      toolResults: { lookup: { state: 'active' } },
    },
  })),
  ...Array.from({ length: 5 }, (_, index): EvaluationCase => {
    const state = `state-${index + 1}`;
    return {
      id: `agent-confirm-${index + 1}`,
      mode: 'agent',
      title: `Requires played confirmation before fixture write ${index + 1}`,
      tags: ['tool', 'write', 'confirmation'],
      turns: [{ input: 'Change state' }, { input: 'yes' }],
      expected: {
        outputs: [confirmation(state), 'The confirmed update completed.'],
        operationCount: 1,
        operationStates: ['succeeded'],
      },
      fixture: {
        inference: [
          { kind: 'tool', toolId: 'update', input: { state } },
          { kind: 'text', text: 'The confirmed update completed.' },
        ],
        toolResults: { update: { updated: true } },
      },
    };
  }),
  ...Array.from({ length: 3 }, (_, index): EvaluationCase => {
    const state = `cancel-${index + 1}`;
    return {
      id: `agent-decline-${index + 1}`,
      mode: 'agent',
      title: `Cancels a pending write without connector effect ${index + 1}`,
      tags: ['tool', 'write', 'cancel'],
      turns: [
        { input: 'Change state' },
        { input: index === 0 ? 'no' : index === 1 ? 'cancel' : 'stop' },
      ],
      expected: {
        outputs: [confirmation(state), 'Cancelled. No change was made.'],
        operationCount: 0,
      },
      fixture: { inference: [{ kind: 'tool', toolId: 'update', input: { state } }] },
    };
  }),
  ...Array.from({ length: 2 }, (_, index): EvaluationCase => ({
    id: `agent-unknown-write-${index + 1}`,
    mode: 'agent',
    title: `Surfaces unknown fixture write without blind retry ${index + 1}`,
    tags: ['tool', 'write', 'unknown-state'],
    turns: [{ input: 'Change state' }, { input: 'yes' }],
    expected: {
      outputIncludes: ['Please confirm: Update account state.', 'I could not complete that check.'],
      operationCount: 1,
      operationStates: ['unknown'],
    },
    fixture: {
      inference: [{ kind: 'tool', toolId: 'update', input: { state: `unknown-${index + 1}` } }],
      toolFailures: ['update'],
    },
  })),
  ...Array.from({ length: 2 }, (_, index): EvaluationCase => ({
    id: `agent-unapproved-${index + 1}`,
    mode: 'agent',
    title: `Rejects unknown model-selected tool ${index + 1}`,
    tags: ['tool', 'unapproved'],
    turns: [{ input: 'Unsafe request' }],
    expected: { errorIncludes: 'unknown or unapproved tool', operationCount: 0 },
    fixture: { inference: [{ kind: 'tool', toolId: `unknown-${index + 1}`, input: {} }] },
  })),
  ...Array.from({ length: 2 }, (_, index): EvaluationCase => ({
    id: `agent-cancel-${index + 1}`,
    mode: 'agent',
    title: `Cancels delayed model turn without stale narration ${index + 1}`,
    tags: ['cancellation', 'mock-model'],
    turns: [{ input: 'Slow request' }],
    expected: { errorIncludes: 'AbortError', operationCount: 0 },
    fixture: {
      inference: [{ kind: 'text', text: 'late narration' }],
      inferenceDelayMs: 20,
      cancelAfterMs: index + 1,
    },
  })),
  {
    id: 'agent-max-steps',
    mode: 'agent',
    title: 'Stops the fixture tool loop at the configured maximum',
    tags: ['tool', 'loop-bound'],
    turns: [{ input: 'Keep checking' }],
    expected: {
      outputs: ['I do not have that information.'],
      operationCount: 4,
      operationStates: ['succeeded', 'succeeded', 'succeeded', 'succeeded'],
    },
    fixture: {
      inference: Array.from({ length: 4 }, (_, index) => ({
        kind: 'tool' as const,
        toolId: 'lookup',
        input: { account: `LOOP-${index}` },
      })),
      toolResults: { lookup: { state: 'active' } },
    },
  },
];
