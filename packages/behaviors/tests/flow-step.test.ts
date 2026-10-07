import { describe, expect, it } from 'vitest';
import { AgentFlow, AgentDecisionPolicy } from '@winsendotai/ovo-contracts';
import {
  AnnouncementValidationError,
  DecisionGate,
  FlowSession,
  UNVERIFIED_FACTS_NOTICE,
  applyFlowStep,
  flowBriefing,
  flowFacts,
  openFlow,
  runDecisionStep,
} from '../src/index.ts';
import { collectionsFlow, scriptedJev } from './flow-fixture.ts';

const plain = (template: string) => template.replace('{{full_name}}', 'Ravi');
const clarification = 'Please say that again.';
const live = () => new AbortController().signal;
const turn = (input: string) => ({ input, history: [], variables: {}, context: '' });

describe('applying a flow step', () => {
  it('renders each line as its own segment and records a line this call cannot fill', () => {
    const flow = new FlowSession(AgentFlow.parse(collectionsFlow()), { timeoutMs: 800 });
    const applied = applyFlowStep(flow, flow.begin()!, {
      clarification,
      render: (template) => {
        if (template.includes('{{full_name}}'))
          throw new AnnouncementValidationError('full_name is missing');
        return template;
      },
    });
    expect(applied).toEqual({
      lines: ["Hello, I'm calling from CreditMantri."],
      speak: "Hello, I'm calling from CreditMantri.",
    });
    expect(flow.path[0]).toMatchObject({ tier: 'start', skippedLines: ['ask_identity'] });
    expect(JSON.stringify(flow.path)).not.toContain('Ravi');
  });

  it('lets any other rendering failure surface', () => {
    const flow = new FlowSession(AgentFlow.parse(collectionsFlow()), { timeoutMs: 800 });
    expect(() =>
      applyFlowStep(flow, flow.begin()!, {
        clarification,
        render: () => {
          throw new TypeError('bug');
        },
      }),
    ).toThrow(TypeError);
  });

  it("speaks the agent's clarification when a clarifying flow has no line of its own", async () => {
    const jev = scriptedJev([{ intent: 'other' }]);
    const flow = new FlowSession(AgentFlow.parse({ ...collectionsFlow(), fallback: 'clarify' }), {
      port: jev.port,
      timeoutMs: 800,
    });
    applyFlowStep(flow, flow.begin()!, { render: plain, clarification });
    const step = await flow.next(turn('blah'), live());
    // A clarification restates; a later repeat replays what came before it, not it.
    expect(applyFlowStep(flow, step, { render: plain, clarification })).toEqual({
      lines: [clarification],
      speak: clarification,
      replay: true,
    });
  });

  it('hands the turn to the LLM at a node authored without lines, and still listens there', () => {
    const authored = collectionsFlow();
    authored.nodes[0]!.say = [];
    const flow = new FlowSession(AgentFlow.parse(authored), { timeoutMs: 800 });
    expect(applyFlowStep(flow, flow.begin()!, { render: plain, clarification })).toEqual({});
    expect(flow.state).toMatchObject({ node: 'greet', listen: 'identity' });
  });

  it('arms the ending with the node that ends the call', async () => {
    const jev = scriptedJev([{ intent: 'wrong_person' }]);
    const flow = new FlowSession(AgentFlow.parse(collectionsFlow()), {
      port: jev.port,
      timeoutMs: 800,
    });
    applyFlowStep(flow, flow.begin()!, { render: plain, clarification });
    const step = await flow.next(turn('wrong number'), live());
    expect(applyFlowStep(flow, step, { render: plain, clarification })).toMatchObject({
      end: 'flow:wrong_person',
      lines: ['Sorry for the trouble. Goodbye.'],
    });
  });
});

describe('opening a flow and gating facts', () => {
  it('speaks the start state once, and nothing without a flow', () => {
    const flow = new FlowSession(AgentFlow.parse(collectionsFlow()), { timeoutMs: 800 });
    expect(openFlow(flow, { render: plain, clarification })).toEqual({
      lines: ["Hello, I'm calling from CreditMantri.", 'Am I speaking with Ravi?'],
      speak: "Hello, I'm calling from CreditMantri. Am I speaking with Ravi?",
    });
    expect(openFlow(flow, { render: plain, clarification })).toBeUndefined();
    expect(openFlow(undefined, { render: plain, clarification })).toBeUndefined();
  });

  it('passes facts through without a flow and gates them with one', () => {
    const flow = new FlowSession(AgentFlow.parse(collectionsFlow()), { timeoutMs: 800 });
    expect(flowFacts(undefined, '- emi: 1')).toBe('- emi: 1');
    expect(flowFacts(flow, '- emi: 1')).toBe(UNVERIFIED_FACTS_NOTICE);
    expect(flowFacts(flow, '')).toBe('');
  });
});

describe('gating the briefing on identity (AGT-5)', () => {
  const briefing = 'You are calling {{full_name}} about an EMI of {{emi}}.';
  const render = (text: string) =>
    text.replace('{{full_name}}', 'Ravi').replace('{{emi}}', 'four thousand rupees');

  it('shows the briefing unrendered until a verified node is entered, then rendered', () => {
    const flow = new FlowSession(AgentFlow.parse(collectionsFlow()), { timeoutMs: 800 });
    flow.commit(flow.begin()!);
    expect(flowBriefing(flow, briefing, render)).toBe(briefing);
    flow.commit({
      kind: 'enter',
      node: 'disclose',
      lines: [],
      end: false,
      transition: { at: '', from: {}, to: {}, tier: 'rule' },
    });
    expect(flowBriefing(flow, briefing, render)).toBe(
      'You are calling Ravi about an EMI of four thousand rupees.',
    );
  });

  it('renders it without a flow, or with a flow that gates nothing', () => {
    expect(flowBriefing(undefined, briefing, render)).toContain('four thousand rupees');
    const flow = collectionsFlow();
    for (const node of flow.nodes) delete (node as { verified?: boolean }).verified;
    const open = new FlowSession(AgentFlow.parse(flow), { timeoutMs: 800 });
    expect(flowBriefing(open, briefing, render)).toContain('four thousand rupees');
  });
});

describe('the decision step with a flow', () => {
  const gate = () =>
    new DecisionGate(
      AgentDecisionPolicy.parse({ enabled: true, flow: collectionsFlow() }),
      scriptedJev([]).port,
    );

  it('never moves the call for a turn that went stale while deciding', async () => {
    const decision = gate();
    await expect(
      runDecisionStep(decision, {
        turn: turn('hello'),
        signal: live(),
        clarification,
        record: () => undefined,
        stale: () => true,
        render: plain,
      }),
    ).rejects.toThrow('stale agent turn');
    expect(decision.flow!.state.started).toBe(false);
    expect(decision.flow!.path).toEqual([]);
  });

  it('returns the lines separately for a caller that speaks them as segments', async () => {
    const decision = gate();
    const result = await runDecisionStep(decision, {
      turn: turn('hello'),
      signal: live(),
      clarification,
      record: () => undefined,
      stale: () => false,
      render: plain,
    });
    expect(result.lines).toEqual([
      "Hello, I'm calling from CreditMantri.",
      'Am I speaking with Ravi?',
    ]);
    expect(result.speak).toBe("Hello, I'm calling from CreditMantri. Am I speaking with Ravi?");
  });

  it('treats a flat policy with no questions as off', async () => {
    const flat = new DecisionGate(
      AgentDecisionPolicy.parse({ enabled: true }),
      scriptedJev([]).port,
    );
    expect(flat.flow).toBeUndefined();
    expect(await flat.evaluate(turn('hi'), live())).toEqual({ kind: 'off' });
  });
});
