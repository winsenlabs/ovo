import { describe, expect, it } from 'vitest';
import {
  AgentFlow,
  compileFlow,
  flowDecisionRequest,
  readFlowAnswer,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { resolveBinding } from '../src/binding.ts';
import { jevDecision } from '../src/decide.ts';
import { jevChoiceBody, jevScript, jevStep } from '../src/testing.ts';
import { LABEL } from './requests.ts';

const flow = compileFlow(
  AgentFlow.parse({
    start: 'ask',
    lines: { ask: 'When can you pay?', ok: 'Noted.' },
    nodes: [
      { id: 'ask', say: ['ask'], listen: 'payment' },
      { id: 'ok', say: ['ok'], end: true },
    ],
    listens: [
      {
        id: 'payment',
        question: 'The agent asked when they can pay. What does `caller_reply` express?',
        intents: [{ key: 'promise_to_pay', description: 'They commit to pay later', next: 'ok' }],
        slots: [
          {
            id: 'ptp_when',
            question: 'By when?',
            options: [
              { key: 'today', description: 'Today' },
              { key: 'later', description: 'Later' },
            ],
          },
        ],
      },
    ],
  }),
);

const request = flowDecisionRequest(flow, 'payment', {
  caller_reply: 'kal pakka',
  agent_last_said: 'When can you pay?',
  recent_turns: ['agent: When can you pay?'],
  today: 'Wednesday, 7 October 2026',
});

describe('a flow decision over the Jev wire (AGT-1)', () => {
  it('sends the scoped intent and the slot in one request, and never the trace', async () => {
    const body = jevChoiceBody(request, { intent: 'promise_to_pay', ptp_when: 'today' });
    const net = createFixtureNet([
      jevScript(
        jevStep({
          where: {
            'questions.intent.criteria.other':
              'None of the above fits: a question, a new topic, or anything the listed options do not cover',
            'questions.ptp_when.criteria.today': 'Today',
            'state.caller_reply': 'kal pakka',
          },
          body,
        }),
      ),
    ]);
    const port = jevDecision(
      net,
      'fixture-key',
      resolveBinding({ calibrationLabel: LABEL }),
      undefined,
      {
        sessionId: 'fixture',
      },
    );
    const response = await port.decide(request, {
      signal: AbortSignal.timeout(5000),
      trace: { flow: { node: 'ask', listen: 'payment' } },
    });
    const sent = JSON.parse(net.log[0]!.data as string) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['model', 'questions', 'state']);
    expect(JSON.stringify(sent)).not.toContain('"ask"');
    expect(readFlowAnswer(flow, request, response)).toEqual({
      kind: 'intent',
      intent: 'promise_to_pay',
      confidence: 0.9,
      modelId: 'jev-2026-07-01',
      slots: { ptp_when: 'today' },
    });
    net.assertComplete();
  });

  it('answers an unpicked question with its last option, the automatic other', () => {
    const body = jevChoiceBody(request, {});
    expect(body.answers.intent).toMatchObject({ choice: 'other' });
    expect(() => jevChoiceBody(request, { intent: 'nope' })).toThrow(/not an option/);
  });
});
