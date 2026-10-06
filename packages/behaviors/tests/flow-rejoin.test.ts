import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  type InferenceReply,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
import { ToolConfirmation } from '../src/confirmation.ts';
import { ToolEvents } from '../src/tool-events.ts';
import { runInferenceSteps, type InferenceStepInput } from '../src/agent-inference-step.ts';
import { AgentToolSelectionError, AgentTurnLog, FlowSession } from '../src/index.ts';
import { collect, execution, llm } from './agent-call-control-fixture.ts';
import { collectionsFlow } from './flow-fixture.ts';

const resume = (input: Record<string, unknown>): InferenceReply => ({
  kind: 'tool',
  toolId: 'resume_flow',
  input,
});

/** A flow already past identity, waiting in the payment state. */
function flowAt(listen: 'identity' | 'payment' = 'payment') {
  const config = AgentConfig.parse({
    name: 'Collections',
    mode: 'agent',
    decision: { enabled: true, flow: collectionsFlow() },
  });
  const flow = new FlowSession(config.decision!.flow!, { timeoutMs: 800 });
  flow.commit(flow.begin()!);
  if (listen === 'payment')
    flow.commit({
      kind: 'enter',
      node: 'disclose',
      lines: [],
      end: false,
      transition: { at: '', from: {}, to: {}, tier: 'rule' },
    });
  return flow;
}

function step(
  replies: (InferenceReply | InferenceStreamEvent[])[],
  options: { flow?: FlowSession; endTool?: boolean; streaming?: boolean } = {},
) {
  const model = llm(replies);
  const ended: string[] = [];
  const events = new ToolEvents();
  const input: InferenceStepInput = {
    config: AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      ...(options.endTool ? { ending: { llmTool: true } } : {}),
    }),
    inference: model.port,
    execution,
    identity: { workspaceId: 'w-1', sessionId: 's-1' },
    tools: [],
    validators: new Map(),
    log: new AgentTurnLog(),
    confirmation: new ToolConfirmation(events.emit),
    events,
    publish: (text) => text,
    endCall: (reason) => ended.push(reason),
    operationId: () => 'op-1',
    turn: 1,
    current: () => true,
    input: 'can I pay half now?',
    history: [],
    context: 'Briefing.',
    results: [],
    streaming: options.streaming ?? false,
    signal: new AbortController().signal,
    uncertainWrite: () => false,
    wrote: false,
    ...(options.flow ? { flow: options.flow } : {}),
  };
  return { run: () => collect(runInferenceSteps(input)), model, ended, input };
}

/** Speaks two sentences, waits for `held`, runs `before`, then calls the tool for the resume point. */
function heldStream(
  held: Promise<void>,
  before: () => void,
  action = 'none',
): InferenceStepInput['inference'] {
  return {
    generate: () => Promise.reject(new Error('this model only streams')),
    async *stream() {
      yield { kind: 'text-delta', delta: 'You can pay part now. ' };
      yield { kind: 'text-delta', delta: 'Anything else?' };
      await held;
      before();
      yield { kind: 'tool', toolId: 'resume_flow', input: { resume_at: 'wrapup', action } };
      yield { kind: 'finish' };
    },
  };
}

describe('the LLM fallback rejoins the flow (AGT-7)', () => {
  it('offers resume points and tells the LLM what the flow was waiting for', async () => {
    const turn = step([{ kind: 'text', text: 'Sure.' }], { flow: flowAt() });
    await turn.run();
    const request = turn.model.requests[0]!;
    const tool = request.tools.find((candidate) => candidate.id === 'resume_flow')!;
    // The answer goes out as text, which streams; the tool carries only where to resume.
    expect(tool.description).toContain('First say your answer to the caller as plain text');
    expect(tool.inputSchema).toMatchObject({
      required: ['resume_at', 'action'],
      properties: {
        resume_at: { enum: ['identity', 'payment', 'wrapup'] },
        action: { enum: ['none'] },
      },
    });
    expect(request.context).toBe(
      [
        'Briefing.',
        '',
        'Conversation flow: the caller said something the scripted conversation could not place.',
        'The agent was waiting for: The agent asked when they can pay. What does the reply express?',
        'Say a brief answer as plain text, then call `resume_flow` with the point the conversation continues from:',
        '- identity: The agent asked who picked up. How did they respond in the reply?',
        '- payment: The agent asked when they can pay. What does the reply express?',
        '- wrapup: The agent asked if there is anything else. What does the reply say?',
      ].join('\n'),
    );
  });

  it('speaks the reply and moves the flow to the chosen listen set', async () => {
    const flow = flowAt();
    const turn = step(
      [
        resume({
          reply: 'You can pay part now. Anything else?',
          resume_at: 'wrapup',
          action: 'none',
        }),
      ],
      { flow },
    );
    expect(await turn.run()).toEqual(['You can pay part now. Anything else?']);
    expect(flow.state).toMatchObject({ node: 'disclose', listen: 'wrapup' });
    expect(flow.path.at(-1)).toMatchObject({ tier: 'llm', intent: 'wrapup' });
    expect(turn.ended).toEqual([]);
  });

  it('keeps the current state when the resume point is not one the flow offers', async () => {
    const flow = flowAt('identity');
    const turn = step(
      [resume({ reply: 'When can you pay?', resume_at: 'payment', action: 'none' })],
      { flow },
    );
    expect(await turn.run()).toEqual(['When can you pay?']);
    expect(flow.state.listen).toBe('identity');
    expect(flow.path.at(-1)).toMatchObject({ reason: 'invalid-resume' });
  });

  it('ends the call through the flow only when the agent lets the LLM end calls', async () => {
    const allowed = step(
      [resume({ reply: 'Goodbye.', resume_at: 'payment', action: 'end_call' })],
      { flow: flowAt(), endTool: true },
    );
    await allowed.run();
    expect(allowed.ended).toEqual(['llm:resume_flow:end']);
    const refused = step([resume({ reply: 'Goodbye.', resume_at: 'end', action: 'none' })], {
      flow: flowAt(),
    });
    await refused.run();
    expect(refused.ended).toEqual([]);
  });

  it('applies a resume called after a streamed reply without breaking the stream', async () => {
    const flow = flowAt();
    const turn = step(
      [
        [
          { kind: 'text-delta', delta: 'I understand. ' },
          { kind: 'text-delta', delta: 'Is there anything else?' },
          { kind: 'tool', toolId: 'resume_flow', input: { resume_at: 'wrapup', action: 'none' } },
          { kind: 'finish' },
        ],
      ],
      { flow, streaming: true },
    );
    expect((await turn.run()).join(' ')).toBe('I understand. Is there anything else?');
    expect(flow.state.listen).toBe('wrapup');
  });

  it('streams a text-first answer to TTS before the resume call arrives', async () => {
    const flow = flowAt();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const turn = step([], { flow, streaming: true });
    turn.input.inference = heldStream(held, () => undefined);
    const replies = runInferenceSteps(turn.input);
    const blocked = new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 500));
    expect(await Promise.race([replies.next().then((next) => next.value), blocked])).toBe(
      'You can pay part now.',
    );
    expect(flow.state.listen).toBe('payment');
    release();
    for await (const _ of replies);
    expect(flow.state.listen).toBe('wrapup');
  });

  it('never applies a late resume from a turn that was superseded mid-stream', async () => {
    const flow = flowAt();
    let stale = false;
    const turn = step([], { flow, streaming: true, endTool: true });
    turn.input.current = () => !stale;
    turn.input.inference = heldStream(Promise.resolve(), () => (stale = true), 'end_call');
    await expect(turn.run()).rejects.toThrow(/stale/);
    expect(flow.state.listen).toBe('payment');
    expect(turn.ended).toEqual([]);
  });

  it('records a plain text answer as an LLM turn that kept the state', async () => {
    const flow = flowAt();
    await step([{ kind: 'text', text: 'Let me check.' }], { flow }).run();
    expect(flow.path.at(-1)).toMatchObject({ tier: 'llm', to: { listen: 'payment' } });
    expect(flow.path.at(-1)).not.toHaveProperty('reason');
  });

  it('treats a malformed resume as a tool protocol error', async () => {
    const turn = step([resume({ resume_at: 'wrapup' })], { flow: flowAt() });
    await expect(turn.run()).rejects.toThrow(AgentToolSelectionError);
  });

  it('offers nothing new to an agent without a flow', async () => {
    const turn = step([{ kind: 'text', text: 'Hi.' }]);
    await turn.run();
    expect(turn.model.requests[0]!.tools).toEqual([]);
    expect(turn.model.requests[0]!.context).toBe('Briefing.');
  });
});
