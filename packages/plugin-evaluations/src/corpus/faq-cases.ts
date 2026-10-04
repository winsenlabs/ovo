import type { EvaluationCase } from '../types.ts';

const answers = [
  ['What are your opening hours', 'We are open from nine to five.'],
  ['business hours', 'We are open from nine to five.'],
  ['when are you open', 'We are open from nine to five.'],
  ['How do I request a refund', 'Refunds are reviewed within five days.'],
  ['money back', 'Refunds are reviewed within five days.'],
  ['refund policy', 'Refunds are reviewed within five days.'],
  ['How do I reset my password', 'Use the reset link on the sign in page.'],
  ['forgot password', 'Use the reset link on the sign in page.'],
  ['password help', 'Use the reset link on the sign in page.'],
] as const;

export const faqCases: EvaluationCase[] = [
  ...Array.from({ length: 15 }, (_, index): EvaluationCase => {
    const [input, output] = answers[index % answers.length]!;
    return {
      id: `faq-answer-${index + 1}`,
      mode: 'faq',
      title: `Matches deterministic FAQ question or alias ${index + 1}`,
      tags: [index % 3 === 0 ? 'question' : 'alias'],
      turns: [{ input }],
      expected: { outputs: [output], operationCount: 0 },
      fixture: {},
    };
  }),
  ...[
    'Do not refund me',
    'never reset password',
    'no opening hours',
    'unrelated weather',
    'account help',
  ].map((input, index): EvaluationCase => ({
    id: `faq-conservative-${index + 1}`,
    mode: 'faq',
    title: `Conservative fallback for negated, ambiguous, or unmatched query ${index + 1}`,
    tags: [index < 3 ? 'negation' : index === 4 ? 'ambiguous' : 'no-match'],
    turns: [{ input }],
    expected: { outputs: ['Please clarify your question.'], operationCount: 0 },
    fixture: {},
  })),
  ...[
    'What is my order status',
    'track order',
    'where is my order',
    'track order',
    'What is my order status',
  ].map((input, index): EvaluationCase => ({
    id: `faq-tool-${index + 1}`,
    mode: 'faq',
    title: `Runs approved FAQ lookup fixture ${index + 1}`,
    tags: ['tool-check', 'read-only'],
    turns: [{ input, variables: { orderId: `ORDER-${index + 1}` } }],
    expected: {
      outputs: ['Your order is packed.'],
      operationCount: 1,
      operationStates: ['succeeded'],
    },
    fixture: { toolResults: { 'order-status': { status: 'packed' } } },
  })),
  {
    id: 'faq-script-text',
    mode: 'faq',
    title: 'Advances script graph on an exact text transition',
    tags: ['script-graph'],
    turns: [{ input: '' }, { input: 'continue' }],
    expected: { outputs: ['Press one or say continue.', 'Script complete.'] },
    fixture: {},
  },
  {
    id: 'faq-script-dtmf',
    mode: 'faq',
    title: 'Advances script graph on a DTMF transition',
    tags: ['script-graph', 'dtmf'],
    turns: [{ input: '' }, { input: '1', variables: { inputEvent: 'dtmf' } }],
    expected: { outputs: ['Press one or say continue.', 'Script complete.'] },
    fixture: {},
  },
  {
    id: 'faq-script-detour',
    mode: 'faq',
    title: 'Answers FAQ detour and repeats current script prompt',
    tags: ['script-graph', 'faq-detour'],
    turns: [{ input: '' }, { input: 'business hours' }],
    expected: {
      outputs: [
        'Press one or say continue.',
        'We are open from nine to five. Press one or say continue.',
      ],
    },
    fixture: {},
  },
  {
    id: 'faq-script-clarify',
    mode: 'faq',
    title: 'Clarifies unmatched script input without changing state',
    tags: ['script-graph', 'ambiguous'],
    turns: [{ input: '' }, { input: 'something else' }],
    expected: {
      outputs: [
        'Press one or say continue.',
        'Please clarify your question. Press one or say continue.',
      ],
    },
    fixture: {},
  },
  {
    id: 'faq-script-terminal',
    mode: 'faq',
    title: 'Produces no new speech after terminal script playback',
    tags: ['script-graph', 'terminal'],
    turns: [{ input: '' }, { input: 'continue' }, { input: 'ignored' }],
    expected: { outputs: ['Press one or say continue.', 'Script complete.', ''] },
    fixture: {},
  },
];
