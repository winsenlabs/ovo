import { describe, expect, it } from 'vitest';
import { AgentConfig, UNTRUSTED_INPUT_VARIABLE } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { call, collect, execution, llm, receipt, variables } from './agent-call-control-fixture.ts';

const END = {
  kind: 'tool',
  toolId: 'end_call',
  input: { goodbye: 'Bye!', reason: 'done' },
} as const;

/** An agent offering end_call, on a clock the test moves. */
function maya(
  replies: Parameters<typeof llm>[0],
  ending: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
) {
  const clock = { ms: Date.parse('2026-10-07T13:42:45Z') };
  const model = llm(replies);
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      variables,
      ending: { llmTool: true, ...ending },
      ...config,
    }),
    model.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', now: () => new Date(clock.ms) },
  );
  let epoch = 0;
  const turn = async (text: string, extra: Record<string, unknown> = {}) => {
    behavior.beginTurn(++epoch);
    const said = await collect(behavior.respondStream(text, { ...call, ...extra }));
    for (const line of said) behavior.onPlayback(receipt(line, epoch));
    return said;
  };
  return { behavior, model, clock, turn };
}

describe("the agent asks EndCallGate before the LLM's end_call ends the call (N1)", () => {
  it('Maya call b1fd8b51: never on the first caller turn, misheard as Russian', async () => {
    const m = maya([
      [
        { kind: 'text-delta', delta: 'Хорошо, спасибо за звонок. До свидания!' },
        { kind: 'tool', toolId: 'end_call', input: { goodbye: 'unused', reason: 'finished' } },
        { kind: 'finish' },
      ],
    ]);
    m.clock.ms += 3_000;
    await m.turn('Нет, это всё.');
    expect(m.behavior.isComplete()).toBe(false);
    expect(m.behavior.toolErrors).toMatchObject([
      {
        toolId: 'end_call',
        kind: 'refused',
        message: 'end_call refused: the caller was not heard clearly',
      },
    ]);
  });

  it('asks the model again, telling it why, when end_call is its whole reply', async () => {
    const m = maya([END, { kind: 'text', text: 'Sure. Which city are you thinking of?' }]);
    m.clock.ms += 5_000;
    expect(await m.turn('Hey.')).toEqual(['Sure.', 'Which city are you thinking of?']);
    expect(m.behavior.isComplete()).toBe(false);
    expect(m.model.requests).toHaveLength(2);
    expect(m.model.requests[1]!.results).toMatchObject([
      {
        toolId: 'end_call',
        state: 'failed',
        error:
          'The call was not ended: the conversation has only just started. Do not say goodbye; ' +
          'answer the caller.',
      },
    ]);
  });

  it('lets it end once the caller has had two turns and the call has run 20 s', async () => {
    const m = maya([{ kind: 'text', text: 'Italy is lovely.' }, END]);
    m.clock.ms += 8_000;
    await m.turn('Tell me about Italy.');
    m.clock.ms += 12_000;
    expect(await m.turn('Thanks, that helps.')).toEqual(['Bye!']);
    expect(m.behavior.completionReason()).toBe('llm:end_call:done');
  });

  it('waits for both minimums: two quick turns are not enough', async () => {
    const m = maya([{ kind: 'text', text: 'Italy is lovely.' }, END]);
    await m.turn('Tell me about Italy.');
    m.clock.ms += 4_000;
    await m.turn('Thanks, that helps.');
    expect(m.behavior.isComplete()).toBe(false);
  });

  it('lets a caller who says goodbye end the call at once', async () => {
    const m = maya([END]);
    await m.turn('Okay thank you, bye.');
    expect(m.behavior.completionReason()).toBe('llm:end_call:done');
  });

  it('never acts on a turn flagged untrusted, even a goodbye', async () => {
    const m = maya([END], { minCallerTurns: 0, minCallSeconds: 0 });
    await m.turn('bye', { [UNTRUSTED_INPUT_VARIABLE]: true });
    expect(m.behavior.isComplete()).toBe(false);
  });

  it('Maya call bcbc7d6a: never right after the agent asked a question', async () => {
    const m = maya(
      [
        [
          { kind: 'text-delta', delta: 'I am here with you. What were you hoping to find out?' },
          { kind: 'tool', toolId: 'end_call', input: { goodbye: 'x', reason: 'appears finished' } },
          { kind: 'finish' },
        ],
      ],
      { minCallerTurns: 0, minCallSeconds: 0 },
    );
    await m.turn('...not mood to pidikirge. I just want to know because-');
    expect(m.behavior.isComplete()).toBe(false);
    expect(m.behavior.toolErrors.at(-1)?.message).toBe(
      'end_call refused: the agent has just asked a question',
    );
  });
});

describe('a final ending says nothing more to a caller who spoke over it (N1)', () => {
  it('a transfer is final: the next turn says nothing and the call still ends', async () => {
    const m = maya([END], { minCallerTurns: 0, minCallSeconds: 0 });
    // Drive the ending to a transfer, as AgentHandoffs arms it.
    (m.behavior as unknown as { ending: { arm(reason: string): void } }).ending.arm('transfer:llm');
    (m.behavior as unknown as { ending: { seal(): void } }).ending.seal();
    expect(m.behavior.isComplete()).toBe(true);
    expect(await m.turn('Wait, one more thing')).toEqual([]);
    expect(m.behavior.completionReason()).toBe('transfer:llm');
    expect(m.model.requests).toHaveLength(0);
  });
});
