import { describe, expect, it } from 'vitest';
import { AgentConfig, UNTRUSTED_INPUT_VARIABLE } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { EndCallGate, foreignScript, saysGoodbye } from '../src/agent-end-gate.ts';
import { call, collect, execution, llm, receipt, variables } from './agent-call-control-fixture.ts';

const END = {
  kind: 'tool',
  toolId: 'end_call',
  input: { goodbye: 'Bye!', reason: 'done' },
} as const;

const EARLY = 'the conversation has only just started';
const UNHEARD = 'the caller was not heard clearly';

/** Maya's gate, on a clock the test moves. */
function gate(ending: Record<string, unknown> = {}) {
  const clock = { ms: Date.parse('2026-10-07T13:42:45Z') };
  const config = AgentConfig.parse({
    name: 'Maya',
    mode: 'agent',
    variables,
    ending: { llmTool: true, ...ending },
  });
  return { gate: new EndCallGate(config, () => clock.ms), clock };
}

describe("the LLM's end_call is refused until the caller is engaged (N1)", () => {
  it('Maya call b1fd8b51: never on the first caller turn, misheard as Russian', () => {
    const g = gate({ minCallerTurns: 0, minCallSeconds: 0 });
    g.clock.ms += 3_000;
    expect(g.gate.turn('Нет, это всё.', {})).toBe(UNHEARD);
  });

  it('refuses the first turn, and two turns until the call has run 20 s', () => {
    const g = gate();
    g.clock.ms += 5_000;
    expect(g.gate.turn('Hey.', {})).toBe(EARLY);
    g.clock.ms += 4_000;
    expect(g.gate.turn('Tell me about Italy.', {})).toBe(EARLY);
    g.clock.ms += 11_000;
    expect(g.gate.turn('Thanks, that helps.', {})).toBeUndefined();
  });

  it('refuses before two turns however long the call has run', () => {
    const g = gate();
    g.clock.ms += 60_000;
    expect(g.gate.turn('Hello?', {})).toBe(EARLY);
    expect(g.gate.turn('Thanks, that helps.', {})).toBeUndefined();
  });

  it('counts a reply rerun on both utterances, after the caller spoke over it, as one turn', () => {
    // AGT-10: "Tell me about" is superseded by "Tell me about Italy" before its reply is heard.
    const g = gate();
    g.clock.ms += 30_000;
    expect(g.gate.turn('Tell me about', {})).toBe(EARLY);
    expect(g.gate.turn('Tell me about Italy', {})).toBe(EARLY);
    expect(g.gate.turn('Thanks, that helps.', {})).toBeUndefined();
  });

  it('lets a caller who says goodbye end the call at once', () => {
    expect(gate().gate.turn('Okay thank you, bye.', {})).toBeUndefined();
  });

  it('honours the agent minimums, 0 lifting them', () => {
    expect(gate({ minCallerTurns: 0, minCallSeconds: 0 }).gate.turn('Hmm.', {})).toBeUndefined();
  });

  it('never acts on a turn flagged untrusted, even a goodbye, nor counts it', () => {
    const g = gate({ minCallerTurns: 2, minCallSeconds: 0 });
    expect(g.gate.turn('bye', { [UNTRUSTED_INPUT_VARIABLE]: true })).toBe(UNHEARD);
    expect(g.gate.turn('ok', {})).toBe(EARLY);
    expect(g.gate.turn('sure', {})).toBeUndefined();
  });
});

describe('an ending the caller can change is reopened by their next turn (N1)', () => {
  it('a reply to a caller who spoke after end_call completed takes the ending back', async () => {
    const model = llm([END, { kind: 'text', text: 'Yes, I am still here.' }]);
    const behavior = new AgentBehavior(
      AgentConfig.parse({
        name: 'Maya',
        mode: 'agent',
        variables,
        ending: { llmTool: true, minCallerTurns: 0, minCallSeconds: 0 },
      }),
      model.port,
      execution,
      { workspaceId: 'w-1', sessionId: 's-1' },
    );
    const turn = async (text: string, epoch: number) => {
      behavior.beginTurn(epoch);
      const said = await collect(behavior.respondStream(text, call));
      for (const line of said) behavior.onPlayback(receipt(line, epoch));
      return said;
    };
    await turn('Nothing more, bye.', 1);
    expect(behavior.isComplete()).toBe(true);
    // The engine held the hang-up for the caller's "Hello?" and runs it as a turn.
    expect(await turn('Hello?', 2)).toEqual(['Yes, I am still here.']);
    expect(behavior.isComplete()).toBe(false);
  });
});

describe('end gate helpers', () => {
  it('reads goodbyes in English, Hinglish, Hindi and Tamil as whole words', () => {
    for (const text of [
      'ok bye',
      'Thank you, goodbye!',
      'phone rakhta hoon',
      'अच्छा बाय',
      'சரி பை',
    ])
      expect(saysGoodbye(text)).toBe(true);
    for (const text of ['bypass the queue', 'Hello', 'why not'])
      expect(saysGoodbye(text)).toBe(false);
  });

  it('lets Indian callers write in any Indian script, not in Cyrillic', () => {
    const indian = new Set(['Latn', 'Deva', 'Taml']);
    expect(foreignScript('இல்லையா? முடிச்சுட்டு போகணும்', indian)).toBe(false);
    expect(foreignScript('NACH, MOOC, புடிக்கிறது கிடையாது sir.', indian)).toBe(false);
    expect(foreignScript('Нет, это всё.', indian)).toBe(true);
    expect(foreignScript('123 ...', indian)).toBe(false);
  });
});
