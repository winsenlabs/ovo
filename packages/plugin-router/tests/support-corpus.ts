import { RoutingEvalCase } from '../src/wire/index.ts';
import { EXAMPLE_IDS as I } from '../src/testing.ts';

const llm = (over: Record<string, unknown>) => ({ node: 'intent', engine: 'llm', ...over });
const everyone = (poolId: string, members: string[]) =>
  members.map((memberId) => ({ poolId, memberId }));

/**
 * Five cases on the example release whose scorecard is worked out by hand in score.test.ts:
 * c1 and c2 are clean routes, c3 expects the wrong branch and member, c4 re-asks and falls to
 * the default, c5 runs into full pools and ends.
 */
export const HAND_CASES = [
  {
    id: 'c1',
    tags: ['sales'],
    turns: [{ kind: 'speech', text: 'mujhe naya card chahiye' }],
    answers: [llm({ branch: 'sales', confidence: 0.91, language: 'hi' })],
    expect: {
      status: 'agent',
      path: ['intent'],
      node: 'intent',
      branches: { intent: 'sales' },
      pool: 'Sales',
      member: 'sales-hi',
      agentId: 'sales-hi',
      language: 'hi',
      fallback: 'none',
      clarify: false,
    },
  },
  {
    id: 'c2',
    tags: ['support'],
    turns: [
      { kind: 'dtmf', digits: '2' },
      { kind: 'speech', text: 'my card' },
    ],
    expect: {
      status: 'agent',
      path: ['intent', 'product'],
      branches: { intent: 'support', product: 'cards' },
      pool: I.supportPool,
      member: 'support-cards',
    },
  },
  {
    id: 'c3',
    tags: ['sales', 'wrong'],
    turns: [{ kind: 'dtmf', digits: '1' }],
    expect: { status: 'agent', branches: { intent: 'support' }, member: 'sales-hi' },
  },
  {
    id: 'c4',
    tags: ['fallback', 'clarify'],
    turns: [
      { kind: 'speech', text: 'umm' },
      { kind: 'speech', text: 'hmm' },
    ],
    answers: [llm({ branch: 'sales', confidence: 0.1, repeat: true })],
    expect: { status: 'agent', fallback: 'default', clarify: true },
  },
  {
    id: 'c5',
    tags: ['end', 'fallback'],
    turns: [
      { kind: 'dtmf', digits: '2' },
      { kind: 'speech', text: 'my loan' },
    ],
    faults: {
      fullMembers: everyone(I.supportPool, ['support-cards', 'support-hi', 'support-loans']),
    },
    expect: { status: 'end', node: 'product', fallback: 'end' },
  },
].map((raw) => RoutingEvalCase.parse(raw));
