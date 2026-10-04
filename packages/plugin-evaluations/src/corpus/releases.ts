import { createHash } from 'node:crypto';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import type { EvaluationCase, ReleaseEvaluationSnapshot } from '../types.ts';

const announcement = AgentConfig.parse({
  name: 'Evaluation announcement',
  mode: 'announcement',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  message: 'Hello {{customer}}, invoice {{invoice}} is {{amount}} and due {{due}}.',
  variables: {
    type: 'object',
    required: ['customer', 'invoice', 'amount', 'due'],
    additionalProperties: false,
    properties: {
      customer: { type: 'string', minLength: 1 },
      invoice: { type: 'string' },
      amount: { type: 'number', 'x-ovo-format': 'currency', 'x-ovo-currency': 'INR' },
      due: { type: 'string', format: 'date' },
    },
  },
});

const faq = AgentConfig.parse({
  name: 'Evaluation FAQ',
  mode: 'faq',
  clarification: 'Please clarify your question.',
  faqThreshold: 0.65,
  faqMargin: 0.15,
  faq: [
    {
      id: 'hours',
      question: 'What are your opening hours',
      aliases: ['business hours', 'when are you open'],
      answer: 'We are open from nine to five.',
    },
    {
      id: 'refund',
      question: 'How do I request a refund',
      aliases: ['money back', 'refund policy', 'account help'],
      answer: 'Refunds are reviewed within five days.',
    },
    {
      id: 'password',
      question: 'How do I reset my password',
      aliases: ['forgot password', 'password help', 'account help'],
      answer: 'Use the reset link on the sign in page.',
    },
    {
      id: 'status',
      question: 'What is my order status',
      aliases: ['track order', 'where is my order'],
      answer: 'Your order is {{result.status}}.',
      requiresTool: 'order-status',
      toolInput: { orderId: '{{orderId}}' },
    },
  ],
  tools: [
    {
      id: 'order-status',
      description: 'Read fixture order state',
      connector: 'native',
      effect: 'read',
      inputSchema: {
        type: 'object',
        required: ['orderId'],
        properties: { orderId: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string' } },
      },
    },
  ],
  allowedTools: ['order-status'],
});

const faqScript = AgentConfig.parse({
  ...faq,
  name: 'Evaluation FAQ script',
  script: {
    start: 'welcome',
    maxVisits: 5,
    nodes: [
      {
        id: 'welcome',
        prompt: 'Press one or say continue.',
        transitions: [
          { event: 'text', matches: ['continue'], to: 'done' },
          { event: 'dtmf', matches: ['1'], to: 'done' },
        ],
      },
      { id: 'done', prompt: 'Script complete.', terminal: true, transitions: [] },
    ],
  },
});

const context = AgentConfig.parse({
  name: 'Evaluation context',
  mode: 'context',
  context: 'OVO support is open Monday to Friday. Refunds take five days.',
  contextBudget: 200,
  uncertainty: 'I do not have that information.',
});
const contextOverflow = AgentConfig.parse({
  ...context,
  name: 'Evaluation context overflow',
  context: 'x'.repeat(201),
  contextBudget: 200,
});

const tools = [
  {
    id: 'lookup',
    description: 'Read account status',
    connector: 'native' as const,
    effect: 'read' as const,
    inputSchema: {
      type: 'object',
      required: ['account'],
      properties: { account: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
  },
  {
    id: 'update',
    description: 'Update account state',
    connector: 'native' as const,
    effect: 'write' as const,
    confirmation: true,
    inputSchema: {
      type: 'object',
      required: ['state'],
      properties: { state: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
  },
];
const agent = AgentConfig.parse({
  name: 'Evaluation agent',
  mode: 'agent',
  context: 'Only use approved fixture tools.',
  contextBudget: 200,
  uncertainty: 'I do not have that information.',
  tools,
  allowedTools: ['lookup', 'update'],
  maxSteps: 4,
});

const releases = {
  announcement: snapshot('fixture-announcement-v1', announcement),
  faq: snapshot('fixture-faq-v1', faq),
  faqScript: snapshot('fixture-faq-script-v1', faqScript),
  context: snapshot('fixture-context-v1', context),
  contextOverflow: snapshot('fixture-context-overflow-v1', contextOverflow),
  agent: snapshot('fixture-agent-v1', agent),
};

export function fixtureReleaseForCase(testCase: EvaluationCase): ReleaseEvaluationSnapshot {
  if (testCase.tags.includes('script-graph')) return releases.faqScript;
  if (testCase.tags.includes('context-overflow')) return releases.contextOverflow;
  return releases[testCase.mode];
}
export const FIXTURE_RELEASES = releases;

function snapshot(
  id: string,
  config: ReturnType<typeof AgentConfig.parse>,
): ReleaseEvaluationSnapshot {
  return {
    id,
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`,
    config,
  };
}
