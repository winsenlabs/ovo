import { describe, expect, it } from 'vitest';
import { AgentConfig, UNTRUSTED_INPUT_VARIABLE } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { call, collect, execution, llm, receipt, variables } from './agent-call-control-fixture.ts';

/**
 * Wave 8b, Maya call e8a43f65 issue 6: 85 s and six caller turns in, STT wrote "Maya, cut the
 * call" (likely) as "Ma'am, create a call.", and the model's end_call, whole (its first token was
 * its last, 1960 ms), hung up: "Sure—I'll let you go. Have a lovely trip…".
 */
const GOODBYE =
  "Sure—I'll let you go. Have a lovely trip, and call me when you're ready to plan the route.";
const END = {
  kind: 'tool',
  toolId: 'end_call',
  input: { goodbye: GOODBYE, reason: 'caller' },
} as const;
const ASK = 'Shall I end the call?';

function maya(replies: Parameters<typeof llm>[0], language = 'en') {
  const clock = { ms: Date.parse('2026-10-12T11:06:12Z') };
  const model = llm(replies);
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      language,
      variables,
      ending: { llmTool: true },
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
  /** The call's first six caller turns, answered, 79 s in. */
  const into = async () => {
    for (const text of ['Zagreb, in December.', 'From the 21st.', 'To the 5th of January.']) {
      clock.ms += 13_000;
      await turn(text);
    }
    for (const text of ['Budapest and Vienna.', 'Then Prague.', 'And Berlin.']) {
      clock.ms += 13_000;
      await turn(text);
    }
    clock.ms += 6_000;
  };
  return { behavior, model, clock, turn, into };
}

describe('call e8a43f65 issue 6: end_call only on a clear goodbye or ask', () => {
  it('asks "Shall I end the call?" for "Ma\'am, create a call." and ends on the yes', async () => {
    const m = maya([...Array(6).fill({ kind: 'text', text: 'Lovely.' }), END, END]);
    await m.into();
    expect(await m.turn("Ma'am, create a call.")).toEqual([ASK]);
    expect(m.behavior.isComplete()).toBe(false);
    expect(m.behavior.toolErrors.at(-1)?.message).toBe(
      'end_call refused: the caller has not clearly asked to end the call',
    );
    // Asked deterministically: no second LLM request for the refused turn.
    expect(m.model.requests).toHaveLength(7);
    m.clock.ms += 3_000;
    // Wave 10 (L2): the yes gets the fixed goodbye at once, with no model request.
    expect(await m.turn('Yes, end it.')).toEqual(['Thank you for your time. Goodbye!']);
    expect(m.model.requests).toHaveLength(7);
    expect(m.behavior.completionReason()).toBe('llm:end_call:caller');
  });

  it('ends at once when the caller asks it clearly, the misheard name restored or not', async () => {
    for (const text of ['Maya, cut the call.', "Ma'am, end the call.", 'Okay, bye.']) {
      const m = maya([...Array(6).fill({ kind: 'text', text: 'Lovely.' }), END]);
      await m.into();
      expect(await m.turn(text), text).toEqual([GOODBYE]);
      expect(m.behavior.isComplete(), text).toBe(true);
    }
  });

  it('asks after a goodbye the model already streamed, rather than hang up', async () => {
    const m = maya([
      ...Array(6).fill({ kind: 'text', text: 'Lovely.' }),
      [
        { kind: 'text-delta', delta: GOODBYE },
        { kind: 'tool', toolId: 'end_call', input: { goodbye: 'unused', reason: 'caller' } },
        { kind: 'finish' },
      ],
    ]);
    await m.into();
    expect(await m.turn("Ma'am, create a call.")).toEqual([
      "Sure—I'll let you go.",
      "Have a lovely trip, and call me when you're ready to plan the route.",
      ASK,
    ]);
    expect(m.behavior.isComplete()).toBe(false);
  });

  it('asks on untrusted words too, in the agent’s language', async () => {
    const m = maya([...Array(6).fill({ kind: 'text', text: 'Lovely.' }), END], 'hi');
    await m.into();
    expect(await m.turn('bye', { [UNTRUSTED_INPUT_VARIABLE]: true })).toEqual([
      'क्या मैं कॉल खत्म कर दूँ?',
    ]);
    expect(m.behavior.isComplete()).toBe(false);
  });

  it('a no to the question ends nothing, even if the model tries', async () => {
    const m = maya([...Array(6).fill({ kind: 'text', text: 'Lovely.' }), END, END]);
    await m.into();
    expect(await m.turn("Ma'am, create a call.")).toEqual([ASK]);
    await m.turn('No, not yet.');
    expect(m.behavior.isComplete()).toBe(false);
  });

  it('a yes to anything else ends nothing', async () => {
    const m = maya([...Array(6).fill({ kind: 'text', text: 'Lovely?' }), END]);
    await m.into();
    expect(await m.turn('Yes.')).toEqual([ASK]);
    expect(m.behavior.isComplete()).toBe(false);
  });
});
