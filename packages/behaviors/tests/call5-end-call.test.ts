import { describe, expect, it } from 'vitest';
import { AgentConfig, UNTRUSTED_INPUT_VARIABLE } from '@winsendotai/ovo-contracts';
import { closesConversation } from '../src/agent-end-gate.ts';
import { AgentBehavior } from '../src/index.ts';
import { call, collect, execution, llm, receipt, variables } from './agent-call-control-fixture.ts';

/**
 * Wave 9, Maya call 10d5ef30 issue D4 (2026-10-12): 4.5 minutes and 18 caller turns in, the model
 * answered "No, I'm good. Thank you." (turn 19, after "…connect through Oslo. Want more detail?")
 * and "Never mind. Thank you." (turn 22, after "What cities and dates have you settled on so
 * far?") with end_call, and the Wave 8b gate turned both into "Shall I end the call?". The caller
 * then said "Yeah, yeah, please." (turn 23) and the call ended: llm:end_call.
 */
const GOODBYE = 'You’re welcome—have a wonderful trip!';
const END = { kind: 'tool', toolId: 'end_call', input: { goodbye: GOODBYE } } as const;
const ASK = 'Shall I end the call?';

function maya() {
  const clock = { ms: Date.parse('2026-10-12T15:54:59Z') };
  const model = llm([...Array(18).fill({ kind: 'text', text: 'Lovely.' }), END, END]);
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      language: 'en',
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
  /** The call's caller turns before turn 19, each answered, 4.5 minutes in. */
  const into = async (turns = 18) => {
    for (let index = 0; index < turns; index += 1) {
      clock.ms += 15_000;
      await turn(`Tell me about stop ${index + 1}.`);
    }
  };
  return { behavior, model, clock, turn, into };
}

describe('call 10d5ef30 D4: a clear closing ends the call without asking', () => {
  it('turn 19: "No, I\'m good. Thank you." gets the goodbye and ends the call', async () => {
    const m = maya();
    await m.into();
    expect(await m.turn("No, I'm good. Thank you.")).toEqual([GOODBYE]);
    expect(m.behavior.completionReason()).toBe('llm:end_call');
  });

  it('turn 22: "Never mind. Thank you." after a question ends the call', async () => {
    const m = maya();
    await m.into();
    expect(await m.turn('Never mind. Thank you.')).toEqual([GOODBYE]);
    expect(m.behavior.isComplete()).toBe(true);
  });

  it('turn 23 as it ran: a yes to "Shall I end the call?" still ends it', async () => {
    const m = maya();
    await m.into();
    // "Thank you." alone may be a thank-you for the answer: it is still asked about.
    expect(await m.turn('Thank you.')).toEqual([ASK]);
    expect(m.behavior.isComplete()).toBe(false);
    expect(await m.turn('Yeah, yeah, please.')).toEqual([GOODBYE]);
    expect(m.behavior.isComplete()).toBe(true);
  });

  it('asks on a closing it did not hear clearly, or before the call has started', async () => {
    const m = maya();
    await m.into();
    expect(await m.turn("No, I'm good. Thank you.", { [UNTRUSTED_INPUT_VARIABLE]: true })).toEqual([
      ASK,
    ]);
    const early = maya();
    await early.into(1);
    // Refused as too early: the model hears why and answers instead (the next scripted reply).
    expect(await early.turn("No, I'm good. Thank you.")).not.toContain(GOODBYE);
    expect(early.behavior.isComplete()).toBe(false);
  });

  it('reads thanks with "need nothing more" as a closing, and nothing less', () => {
    for (const text of [
      "No, I'm good. Thank you.",
      'Never mind. Thank you.',
      "That's all, thanks.",
      'All set, thank you so much.',
      'Bas, itna hi. Thank you.',
    ])
      expect(closesConversation(text), text).toBe(true);
    for (const text of [
      'Thank you.',
      'No thanks.',
      "No, I'm good.",
      "No, I'm good. Thank you. Can you email this to me?",
      "Thanks, that's fine, but what about Rome?",
      "That's fine, thank you.",
      "I'm good, thanks. And Vienna?",
    ])
      expect(closesConversation(text), text).toBe(false);
  });
});
