import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { ToolConfirmation } from '../src/confirmation.ts';
import { ToolEvents } from '../src/tool-events.ts';
import { runInferenceSteps, type InferenceStepInput } from '../src/agent-inference-step.ts';
import { AgentTurnLog } from '../src/index.ts';
import { collect, execution, llm } from './agent-call-control-fixture.ts';

const LONG =
  'Zagreb is the capital of Croatia. It has a lovely upper town with old streets. The market is great. The museums are worth a morning.';

/** One streamed agent turn whose model says `reply`. */
function turn(reply: string, config: Record<string, unknown>) {
  const events = new ToolEvents();
  const input: InferenceStepInput = {
    config: AgentConfig.parse({ name: 'Maya', mode: 'agent', ...config }),
    inference: llm([[{ kind: 'text-delta', delta: reply }, { kind: 'finish' }]]).port,
    execution,
    identity: { workspaceId: 'w-1', sessionId: 's-1' },
    tools: [],
    validators: new Map(),
    log: new AgentTurnLog(),
    confirmation: new ToolConfirmation(events.emit),
    events,
    publish: (text) => text,
    endCall: () => undefined,
    operationId: () => 'op-1',
    turn: 1,
    current: () => true,
    input: 'Tell me about Zagreb.',
    history: [],
    context: 'Briefing.',
    results: [],
    streaming: true,
    signal: new AbortController().signal,
    uncertainWrite: () => false,
    wrote: false,
  };
  return collect(runInferenceSteps(input));
}

describe('call-3 #7: the cap as an agent configures it, through the inference step', () => {
  it('caps a long answer by default', async () => {
    expect((await turn(LONG, {})).join(' ')).toBe(
      'Zagreb is the capital of Croatia. It has a lovely upper town with old streets. Want more detail?',
    );
  });

  it('is off for an agent with maxSentences 0', async () => {
    expect((await turn(LONG, { reply: { maxSentences: 0 } })).join(' ')).toBe(LONG);
  });

  it('never offers more in English to an agent that replies in Hindi on an English locale', async () => {
    const said = await turn(LONG, { language: 'hi-IN', locale: 'en-IN' });
    expect(said.join(' ')).not.toContain('Want more detail?');
  });
});
