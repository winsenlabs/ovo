import type { EvaluationCase } from '../types.ts';

export const contextCases: EvaluationCase[] = [
  ...Array.from({ length: 20 }, (_, index): EvaluationCase => ({
    id: `context-grounded-${index + 1}`,
    mode: 'context',
    title: `Returns transparent grounded fixture response ${index + 1}`,
    tags: ['grounded', 'mock-model'],
    turns: [{ input: index % 2 ? 'When are you open?' : 'How long do refunds take?' }],
    expected: {
      outputs: [index % 2 ? 'Support is open Monday to Friday.' : 'Refunds take five days.'],
    },
    fixture: {
      inference: [
        {
          kind: 'text',
          text: index % 2 ? 'Support is open Monday to Friday.' : 'Refunds take five days.',
        },
      ],
    },
  })),
  ...Array.from({ length: 5 }, (_, index): EvaluationCase => ({
    id: `context-uncertainty-${index + 1}`,
    mode: 'context',
    title: `Uses uncertainty protocol for empty model response ${index + 1}`,
    tags: ['uncertainty', 'mock-model'],
    turns: [{ input: 'What is not in the supplied context?' }],
    expected: { outputs: ['I do not have that information.'] },
    fixture: { inference: [{ kind: 'text', text: index % 2 ? '   ' : '' }] },
  })),
  ...Array.from({ length: 3 }, (_, index): EvaluationCase => ({
    id: `context-cancel-${index + 1}`,
    mode: 'context',
    title: `Cancels delayed fixture inference without late response ${index + 1}`,
    tags: ['cancellation', 'mock-model'],
    turns: [{ input: 'Slow question' }],
    expected: { errorIncludes: 'AbortError' },
    fixture: {
      inference: [{ kind: 'text', text: 'late answer' }],
      inferenceDelayMs: 20,
      cancelAfterMs: index + 1,
    },
  })),
  ...Array.from({ length: 2 }, (_, index): EvaluationCase => ({
    id: `context-overflow-${index + 1}`,
    mode: 'context',
    title: `Rejects context beyond configured code-point budget ${index + 1}`,
    tags: ['context-overflow', 'bounds'],
    turns: [{ input: 'Question' }],
    expected: { errorIncludes: 'exceeding the configured budget' },
    fixture: {},
  })),
];
