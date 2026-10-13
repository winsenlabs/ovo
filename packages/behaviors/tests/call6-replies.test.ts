import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  SAID_BEFORE_REPLY_VARIABLE,
  UNTRUSTED_INPUT_VARIABLE,
  type InferenceReply,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { call, collect, execution, llm, receipt, variables } from './agent-call-control-fixture.ts';
import { slowLlm } from './speculation-fixture.ts';

/**
 * Wave 10: Maya call 4f1a919d (2026-10-13 07:49:51–07:52:55 UTC, main 54fd9ea), the caller's words
 * and the agent's lines as the call ran.
 */
const SAID = {
  turn7: 'Chennai, Chennai.',
  turn8: 'Madras.',
  turn7Reply: [
    'The easiest option is usually one ticket from Chennai with a single stop, often through Dubai, Doha, or another major hub.',
    'Which European city are you heading to, and when?',
  ],
  turn10Reply: [
    'Lufthansa’s schedule shows nonstop Chennai to Frankfurt flights.',
    'Which day works better for you?',
  ],
  turn11: "No, okay, I'll take it later. Thank you so much.",
  turn12: 'Yeah, yeah.',
};
const ASK = 'Shall I end the call?';
const GOODBYE = 'You’re very welcome. Have a lovely trip, and goodbye!';
const FIXED_GOODBYE = 'Thank you for your time. Goodbye!';
const RESUME = 'Sure. What else can I help you with?';
const END: InferenceReply = {
  kind: 'tool',
  toolId: 'end_call',
  input: { goodbye: GOODBYE, reason: 'Caller confirmed they are ready to end the call.' },
};

/** Maya with end_call on a clock the test moves, ten caller turns and 2.5 minutes in. */
function maya(replies: (InferenceReply | InferenceStreamEvent[])[], language = 'en-IN') {
  const clock = { ms: Date.parse('2026-10-13T07:49:51Z') };
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
  /** The call's first caller turns, each answered with `lines`. */
  const into = async (turns: number, lines: string[]) => {
    for (let index = 0; index < turns; index += 1) {
      clock.ms += 15_000;
      replies.unshift(lines.length === 1 ? { kind: 'text', text: lines[0]! } : textEvents(lines));
      await turn(`Tell me about stop ${index + 1}.`);
    }
  };
  return { behavior, model, clock, turn, into, replies };
}

function textEvents(lines: string[]): InferenceStreamEvent[] {
  return [{ kind: 'text-delta', delta: lines.join(' ') }, { kind: 'finish' }];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('call 4f1a919d B3: a decline put off with thanks, after a question, closes the call', () => {
  it('turn 11: gets the model’s goodbye and ends, with no "Shall I end the call?"', async () => {
    // Before: [ASK], the call open, and turn 12 needed to end it.
    const m = maya([END]);
    await m.into(10, SAID.turn10Reply);
    expect(await m.turn(SAID.turn11)).toEqual([GOODBYE]);
    expect(m.behavior.completionReason()).toBe(
      'llm:end_call:Caller confirmed they are ready to end the call.',
    );
  });

  it('still asks when it answers no question or offer of the agent’s', async () => {
    const m = maya([END]);
    await m.into(10, ['Lufthansa flies nonstop from Chennai to Frankfurt.']);
    expect(await m.turn(SAID.turn11)).toEqual([ASK]);
    expect(m.behavior.isComplete()).toBe(false);
  });
});

describe('call 4f1a919d L2: a plain yes or no to "Shall I end the call?" needs no model', () => {
  it('turn 12: "Yeah, yeah." is told goodbye at once, with the line the release pre-renders', async () => {
    const m = maya([END]);
    await m.into(10, ['Lufthansa flies nonstop from Chennai to Frankfurt.']);
    expect(await m.turn('Thank you.')).toEqual([ASK]);
    const asked = m.model.requests.length;
    // Before: a model request (1,577 ms live, after "One moment.") for the model's goodbye.
    expect(await m.turn(SAID.turn12)).toEqual([FIXED_GOODBYE]);
    expect(m.model.requests).toHaveLength(asked);
    expect(m.behavior.isComplete()).toBe(true);
    // The ending is the model's own end_call, which the caller confirmed.
    expect(m.behavior.completionReason()).toBe(
      'llm:end_call:Caller confirmed they are ready to end the call.',
    );
  });

  it('a plain no carries on, at once, and the next turn is the model’s again', async () => {
    const m = maya([END]);
    await m.into(10, ['Lufthansa flies nonstop from Chennai to Frankfurt.']);
    await m.turn('Thank you.');
    const asked = m.model.requests.length;
    expect(await m.turn('No, no.')).toEqual([RESUME]);
    expect(m.model.requests).toHaveLength(asked);
    expect(m.behavior.isComplete()).toBe(false);
    expect(await m.turn('What about hotels in Frankfurt?')).toEqual(['A composed LLM answer.']);
    expect(m.model.requests).toHaveLength(asked + 1);
  });

  it('leaves a yes with more to it, and words heard unclearly, to the model', async () => {
    for (const [text, extra] of [
      ['Yes, but first tell me about hotels.', {}],
      ['Yeah, yeah.', { [UNTRUSTED_INPUT_VARIABLE]: true }],
      ['Yeah, yeah.', { [SAID_BEFORE_REPLY_VARIABLE]: 'Thank you.' }],
    ] as const) {
      const m = maya([END, { kind: 'text', text: 'Of course.' }]);
      await m.into(10, ['Lufthansa flies nonstop from Chennai to Frankfurt.']);
      await m.turn('Thank you.');
      const asked = m.model.requests.length;
      expect(await m.turn(text, extra), text).not.toEqual([FIXED_GOODBYE]);
      expect(m.model.requests.length, text).toBeGreaterThan(asked);
    }
  });

  it('says the Hindi lines to a Hindi caller', async () => {
    const m = maya([END], 'hi-IN');
    await m.into(10, ['लुफ्थांसा सीधी उड़ान देती है।']);
    expect(await m.turn('धन्यवाद।')).toEqual(['क्या मैं कॉल खत्म कर दूँ?']);
    expect(await m.turn('हाँ जी')).toEqual(['आपके समय के लिए धन्यवाद। नमस्ते!']);
    expect(m.behavior.isComplete()).toBe(true);
  });

  it('asks the model nothing ahead on a yes it will answer itself', async () => {
    const m = maya([END]);
    await m.into(10, ['Lufthansa flies nonstop from Chennai to Frankfurt.']);
    await m.turn('Thank you.');
    const asked = m.model.requests.length;
    m.behavior.prepare({ turnId: 'turn-12', text: SAID.turn12, stable: true, variables: call });
    expect(m.model.requests).toHaveLength(asked);
  });
});

describe('call 4f1a919d B1: words said before the caller heard the reply', () => {
  const ANSWER = 'Madras is the old name for Chennai.';

  it('turn 8: "Madras." is read with "Chennai, Chennai.", and cannot end the call', async () => {
    const m = maya([]);
    await m.into(6, ['I didn’t catch the departure city. Could you say it again?']);
    m.replies.push(textEvents(SAID.turn7Reply));
    await m.turn(SAID.turn7);
    // As live: the model ends the call on "Madras." asked after "Which European city…?".
    m.replies.push(END, { kind: 'text', text: ANSWER });
    m.model.requests.length = 0;
    // turn 7's reply, played in full before turn 8 ran.
    const said = await m.turn(SAID.turn8, { [SAID_BEFORE_REPLY_VARIABLE]: SAID.turn7 });
    // Before: [ASK] ("Shall I end the call?").
    expect(said).toEqual([ANSWER]);
    expect(m.behavior.isComplete()).toBe(false);
    expect(m.behavior.toolErrors.at(-1)?.message).toBe(
      'end_call refused: the caller said this before hearing your last reply',
    );
    const [request] = m.model.requests;
    // The whole history, turn 7 and its answer included, and the note.
    const history = request!.history ?? [];
    const asked = history.findIndex((entry) => entry.content === SAID.turn7);
    expect(history[asked]?.role).toBe('user');
    expect(
      history
        .slice(asked + 1)
        .map((entry) => entry.content)
        .join(' '),
    ).toBe(SAID.turn7Reply.join(' '));
    expect(request!.context).toContain(
      'The caller said "Madras." straight after "Chennai, Chennai.", before they heard your reply',
    );
    // "Madras." asks nothing new: no web search for it.
    expect(request!.providerTools).toBe(false);
  });

  it('a goodbye among such words still ends the call; a question keeps the search', async () => {
    const bye = maya([{ ...END, input: { goodbye: 'Bye!', reason: 'bye' } }]);
    await bye.into(6, ['Sure.']);
    await bye.turn('Okay, bye.', { [SAID_BEFORE_REPLY_VARIABLE]: SAID.turn7 });
    expect(bye.behavior.isComplete()).toBe(true);

    const asks = maya([]);
    await asks.into(6, ['Sure.']);
    await asks.turn('What about hotels in Prague?', { [SAID_BEFORE_REPLY_VARIABLE]: SAID.turn7 });
    expect(asks.model.requests.at(-1)!.providerTools).toBeUndefined();
  });

  it('turn 8 is not asked ahead while turn 7 still waits for its answer (B2’s second search)', async () => {
    vi.useFakeTimers();
    const model = slowLlm();
    const behavior = new AgentBehavior(
      AgentConfig.parse({ name: 'Maya', mode: 'agent', ending: { llmTool: true } }),
      model.port,
      execution,
      { workspaceId: 'w-1', sessionId: 's-1' },
    );
    behavior.beginTurn(1);
    const turn7 = collect(behavior.respondStream(SAID.turn7, {}));
    await vi.advanceTimersByTimeAsync(100);
    expect(model.requests).toHaveLength(1);
    // Live: req_6f83ba2c, asked here on "Madras.", searched for 5.1 s and was thrown away.
    behavior.prepare({ turnId: 'turn-8', text: SAID.turn8, stable: true, variables: {} });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(model.requests).toHaveLength(1);
    expect(behavior.speculationMetrics.llm.onPartials).toBe(0);
    await turn7;
  });
});

describe('call 4f1a919d L3: the behaviour says whether its reply may search', () => {
  it('is unknown until the model is asked, then reads the request the model got', async () => {
    const sends = vi.fn((request: { input: string }) => request.input.includes('?'));
    const model = llm([]);
    const port = { ...model.port, sendsProviderTools: sends };
    const behavior = new AgentBehavior(
      AgentConfig.parse({ name: 'Maya', mode: 'agent' }),
      port,
      execution,
      { workspaceId: 'w-1', sessionId: 's-1' },
    );
    behavior.beginTurn(1);
    expect(behavior.lookingUp()).toBeUndefined();
    await collect(behavior.respondStream('Okay.', {}));
    expect(behavior.lookingUp()).toBe(false);
    behavior.beginTurn(2);
    expect(behavior.lookingUp()).toBeUndefined();
    await collect(behavior.respondStream('What are ruin bars?', {}));
    expect(behavior.lookingUp()).toBe(true);
  });

  it('counts a call to one of the agent’s own tools as looking something up', async () => {
    // Review of ec1194c: "Yes, please." to "Shall I check the open slots for you?".
    const model = llm([
      { kind: 'tool', toolId: 'check_slots', input: {} },
      { kind: 'text', text: 'You have slots at 3 and 5 pm.' },
    ]);
    const behavior = new AgentBehavior(
      AgentConfig.parse({
        name: 'Maya',
        mode: 'agent',
        allowedTools: ['check_slots'],
        tools: [
          {
            id: 'check_slots',
            connector: 'native',
            effect: 'read',
            description: 'Check the open slots',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
      { ...model.port, sendsProviderTools: () => false },
      {
        execute: async (request) => ({
          ...request,
          state: 'succeeded',
          result: { slots: ['3 pm', '5 pm'] },
          createdAt: 'now',
        }),
      },
      { workspaceId: 'w-1', sessionId: 's-1' },
    );
    behavior.beginTurn(1);
    expect(await collect(behavior.respondStream('Yes, please.', {}))).toEqual([
      'You have slots at 3 and 5 pm.',
    ]);
    expect(model.requests).toHaveLength(2);
    // Before: false, as neither request was sent the web search.
    expect(behavior.lookingUp()).toBe(true);
  });

  it('counts an end_call as the reply’s words being in', async () => {
    const m = maya([END]);
    await m.into(10, ['Lufthansa flies nonstop from Chennai to Frankfurt.']);
    m.behavior.beginTurn(100);
    const stream = m.behavior.respondStream('Thank you.', call)[Symbol.asyncIterator]();
    await stream.next();
    expect(m.behavior.drafting()).toBe(true);
  });
});
