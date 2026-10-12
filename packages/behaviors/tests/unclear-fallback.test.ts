import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  agentUnclearLines,
  type Inference,
  type InferenceRequest,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';

const GREETING = "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";
const UNSURE = "I'm not completely sure about that. Want me to look it up?";
const AGAIN = 'Sorry, could you say that again?';
const STILL = "Sorry, I still didn't catch that. Could you put it another way?";

/** An LLM that streams each scripted reply in small deltas, as gpt-6-luna does. */
function scripted(replies: string[]) {
  const requests: InferenceRequest[] = [];
  const port: Inference = {
    generate: async (request) => {
      requests.push(request);
      return { kind: 'text', text: replies.shift() ?? '' };
    },
    async *stream(request) {
      requests.push(request);
      const text = replies.shift() ?? '';
      for (const delta of text.match(/.{1,7}/gsu) ?? []) yield { kind: 'text-delta', delta };
      yield { kind: 'finish' };
    },
  };
  return { port, requests };
}

function maya(replies: string[], config: Record<string, unknown> = {}) {
  const llm = scripted(replies);
  const agent = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      uncertainty: UNSURE,
      opening: { lines: [GREETING] },
      languages: { allowed: ['en', 'hi'] },
      ...config,
    }),
    llm.port,
    { execute: async () => ({}) as never },
    { workspaceId: 'w-1', sessionId: 's-1', speculation: { llmPartials: false } },
  );
  return { agent, llm };
}

const played = (text: string, epoch: number): SpeechReceipt => ({
  id: crypto.randomUUID(),
  text,
  epoch,
  state: 'completed',
  evidence: 'confirmed',
});

/** Plays a whole call: the greeting, then each caller line's streamed reply, heard in full. */
async function call(agent: AgentBehavior, lines: string[]): Promise<string[][]> {
  agent.beginTurn(0);
  for (const line of await collect(agent.respondStream('', { inputEvent: 'opening' })))
    agent.onPlayback(played(line, 0));
  const replies: string[][] = [];
  for (const [index, input] of lines.entries()) {
    agent.beginTurn(index + 1);
    const reply = await collect(agent.respondStream(input, {}));
    for (const line of reply) agent.onPlayback(played(line, index + 1));
    replies.push(reply);
  }
  return replies;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const segment of stream) out.push(segment);
  return out;
}

describe('the uncertainty line is never the answer to unclear words (call-3 #3)', () => {
  it('asks the caller to say it again, never twice the same way (call 6e1a4e3a turns 1, 9, 11, 19)', async () => {
    // Live, each of these got the uncertainty line: four times in one call.
    const heard = ['हाँ।', 'Hardik?', 'Credit. Okay, so...', 'जानकार, जानकार। एक लाख...'];
    const { agent } = maya(heard.map(() => UNSURE));
    const replies = await call(agent, heard);
    expect(replies).toEqual([[AGAIN], [STILL], [AGAIN], [STILL]]);
    expect(replies.flat().join(' ')).not.toContain('not completely sure');
  });

  it('keeps the uncertainty line for a question it cannot answer', async () => {
    const { agent } = maya([UNSURE, UNSURE]);
    const [first, second] = await call(agent, [
      'Who won the Zagreb half marathon this year?',
      'And what was the winning time?',
    ]);
    expect(first).toEqual(["I'm not completely sure about that.", 'Want me to look it up?']);
    // P10: not twice in a row, even for a real question: the clarification instead.
    expect(second).toEqual(['Please clarify your question.']);
  });

  it('asks again for a whole reply too, and for words cut off or garbled', async () => {
    const { agent } = maya([UNSURE, UNSURE]);
    agent.beginTurn(0);
    expect(await agent.respond('Credit. Okay, so...')).toBe(AGAIN);
    expect(await agent.respond('Who runs the Zagreb tram network today?')).toBe(UNSURE);
  });

  it('keeps the uncertainty line for a follow-up statement after an answer that asked nothing', async () => {
    // Statements of two or more words are follow-ups, not unclear words, whatever word they open on.
    const answer = 'Zagreb in December averages about 3 degrees.';
    for (const input of ['And in Split.', 'Restaurants near the Colosseum.']) {
      const { agent } = maya([answer, UNSURE, UNSURE]);
      const [, streamed] = await call(agent, ['What is Zagreb like in December?', input]);
      expect(streamed, input).toEqual([
        "I'm not completely sure about that.",
        'Want me to look it up?',
      ]);
      agent.beginTurn(9);
      // Whole: P10 turns a second uncertainty line into the clarification, never an ask-again.
      expect(await agent.respond(input), input).toBe('Please clarify your question.');
    }
  });

  it('keeps the offer after an answer to unclear words: only a reply that opens with the line asks again', async () => {
    const reply =
      'Zagreb in December is magical, with Christmas markets everywhere. Want me to look it up?';
    for (const input of ['Hmm.', 'Zagreb, in December.']) {
      const { agent } = maya([reply]);
      const [segments] = await call(agent, [input]);
      // The whole reply, its own offer last: no ask-again line after a real answer.
      expect(segments!.join(' '), input).toBe(reply);
      expect(segments!.at(-1), input).toBe('Want me to look it up?');
    }
  });

  it('turns a repeated ask-again line of the model into the next one', async () => {
    const { agent } = maya([AGAIN, AGAIN, 'Zagreb is lovely in December.']);
    const replies = await call(agent, ['Hmm.', 'Mm.', 'Zagreb.']);
    expect(replies).toEqual([[AGAIN], [STILL], ['Zagreb is lovely in December.']]);
  });
});

describe('a bare yes answers the agent’s last question (call-3 #3)', () => {
  it('tells the LLM that "हाँ" is a yes to the question it just asked', async () => {
    const { agent, llm } = maya(['Great! Where in Europe are you thinking of going?']);
    await call(agent, ['हाँ।']);
    expect(llm.requests[0]!.context).toContain(
      `The caller's "हाँ" means yes, in answer to your last question ("${GREETING}").`,
    );
    expect(llm.requests[0]!.context).toContain('Do not say you are unsure.');
  });

  it('says nothing of the kind for an answer that is not a yes, or a yes to no question', async () => {
    const { agent, llm } = maya(['Lovely.', 'Sure, Zagreb it is.', 'Great.']);
    await call(agent, ['Zagreb.', 'Haan ji.']);
    expect(llm.requests[0]!.context).not.toContain('means yes');
    // "Lovely." asked nothing.
    expect(llm.requests[1]!.context).not.toContain('means yes');
  });

  it('reads the same note from a partial and a final that differ only in punctuation', async () => {
    const one = maya(['Okay.']);
    const two = maya(['Okay.']);
    await call(one.agent, ['Haan ji.']);
    await call(two.agent, ['haan ji']);
    expect(one.llm.requests[0]!.context).toBe(two.llm.requests[0]!.context);
  });
});

describe('the ask-again lines', () => {
  it('default to the agent’s language, else its clarification, unless authored', () => {
    const base = { name: 'A', mode: 'agent' as const };
    expect(agentUnclearLines(AgentConfig.parse(base))).toEqual([AGAIN, STILL]);
    expect(agentUnclearLines(AgentConfig.parse({ ...base, language: 'hi-IN' }))[0]).toBe(
      'माफ़ कीजिए, क्या आप फिर से बता सकते हैं?',
    );
    expect(
      agentUnclearLines(
        AgentConfig.parse({ ...base, language: 'ta-IN', clarification: 'மீண்டும் சொல்லுங்கள்?' }),
      ),
    ).toEqual(['மீண்டும் சொல்லுங்கள்?']);
    expect(
      agentUnclearLines(AgentConfig.parse({ ...base, unclear: { lines: ['Pardon?'] } })),
    ).toEqual(['Pardon?']);
  });

  it('uses the authored lines', async () => {
    const { agent } = maya([UNSURE], { unclear: { lines: ['Pardon me, say that once more?'] } });
    expect(await call(agent, ['Hardik?'])).toEqual([['Pardon me, say that once more?']]);
  });
});
