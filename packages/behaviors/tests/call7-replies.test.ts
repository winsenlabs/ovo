import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  SAID_BEFORE_REPLY_VARIABLE,
  type Inference,
  type InferenceRequest,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { DEFAULT_MORE_LINES } from '../src/reply-cap.ts';
import { collect, execution, receipt } from './agent-call-control-fixture.ts';

/**
 * Wave 12, Maya call 8cb76efc (2026-10-14, main b18b24e): the reply side, turn by turn, with the
 * call's words. The model is scripted as it answered live; what it held back and the call never
 * logged is marked MODELLED.
 */
const UNSURE = "I'm not completely sure about that. Want me to look it up?";

/** A port with OpenAI's web search: sent unless the request says no, or yes when it says so. */
function searching(answer: (request: InferenceRequest, tools: boolean) => string) {
  const requests: { request: InferenceRequest; tools: boolean }[] = [];
  const sends = (request: Omit<InferenceRequest, 'signal'>) => request.providerTools !== false;
  const port: Inference = {
    generate: async (request) => {
      const tools = sends(request);
      requests.push({ request, tools });
      return { kind: 'text', text: answer(request, tools) };
    },
    async *stream(request) {
      const tools = sends(request);
      requests.push({ request, tools });
      for (const delta of answer(request, tools).match(/.{1,9}/gsu) ?? [])
        yield { kind: 'text-delta', delta };
      yield { kind: 'finish' };
    },
    sendsProviderTools: sends,
  };
  return { port, requests };
}

function maya(port: Inference) {
  return new AgentBehavior(
    AgentConfig.parse({ name: 'Maya', mode: 'agent', language: 'en-IN', uncertainty: UNSURE }),
    port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', speculation: { llmPartials: false } },
  );
}

describe('call 8cb76efc F1: the uncertainty line is not the answer to words that can be answered', () => {
  const GOT_IT = 'Got it, around the 12th of January. How many days will you have?';

  it('turn 11: "Jan 12th, 2024." said before turn 10’s reply is asked again, with the search', async () => {
    // Wave 10's B1 sent it no search tool (it adds to "Sometime around December to... January."
    // and asks nothing); live, the model answered with the uncertainty line (req_b818eb35).
    const { port, requests } = searching((request, tools) =>
      request.providerTools === true ? GOT_IT : tools ? GOT_IT : UNSURE,
    );
    const agent = maya(port);
    agent.beginTurn(1);
    const said = await collect(
      agent.respondStream('Jan 12th, 2024.', {
        [SAID_BEFORE_REPLY_VARIABLE]: 'Sometime around December to... January.',
      }),
    );
    // Before: ["I'm not completely sure about that.", "Want me to look it up?"].
    expect(said).toEqual(['Got it, around the 12th of January.', 'How many days will you have?']);
    expect(requests.map(({ request }) => request.providerTools)).toEqual([false, true]);
    expect(requests[1]!.request.context).toContain(
      `You were about to answer the caller with the line "${UNSURE}". Do not say it`,
    );
  });

  it('asks again only once, and keeps the line when the search finds nothing either', async () => {
    const { port, requests } = searching(() => UNSURE);
    const agent = maya(port);
    agent.beginTurn(1);
    const said = await collect(
      agent.respondStream('Jan 12th, 2024.', {
        [SAID_BEFORE_REPLY_VARIABLE]: 'Sometime around December to... January.',
      }),
    );
    expect(said).toEqual([UNSURE]);
    expect(requests).toHaveLength(2);
  });

  it('never asks again for unclear words, nor when the request already had the search', async () => {
    const { port, requests } = searching(() => UNSURE);
    const agent = maya(port);
    agent.beginTurn(1);
    expect(await collect(agent.respondStream('Credit. Okay, so...', {}))).toEqual([
      'Sorry, could you say that again?',
    ]);
    agent.beginTurn(2);
    expect(await collect(agent.respondStream('Who won the Zagreb half marathon?', {}))).toEqual([
      UNSURE,
    ]);
    expect(requests).toHaveLength(2);
  });

  it('says the held line with what follows it when the reply goes on', async () => {
    const { port } = searching(() => `${UNSURE} Zagreb is lovely in December, though.`);
    const agent = maya(port);
    agent.beginTurn(1);
    expect(
      (await collect(agent.respondStream('Who won the Zagreb half marathon?', {}))).join(' '),
    ).toBe(`${UNSURE} Zagreb is lovely in December, though.`);
  });
});

/** Call 8cb76efc's answers from turn 13 on, as the caller said them and the model answered. */
const ANSWERS: [caller: string, model: string][] = [
  [
    'No, I, I just did.',
    'You’re right, you did. I’m sorry. ' +
      /* MODELLED */ 'Zagreb grew from two medieval towns, Kaptol and Gradec, which joined in 1850 and became Croatia’s capital, a city of cafés and museums.',
  ],
  [
    'As a tourist?',
    'Yes, Croatia is generally considered safe for tourists, including in popular cities and tourist areas; use normal precautions with valuables, and stay on marked roads and paths in remote countryside. Would you like me to check safety for a particular place, such as Zagreb or Dubrovnik?',
  ],
  [
    'Yeah, for both these places.',
    'Zagreb and Dubrovnik are generally safe for tourists, and Croatia has low crime rates, though pickpocketing can happen in busy tourist areas. ' +
      /* MODELLED */ 'Keep an eye on bags in Dubrovnik’s Old Town in summer, when it is busiest.',
  ],
  [
    'Please.',
    'Sure. In Zagreb and Dubrovnik, keep your valuables secure in crowded areas, use licensed taxis or trusted ride services, and be cautious on Dubrovnik’s steep, slippery stone streets. Would you like advice on getting around in either city?',
  ],
  [
    'Have there been any- Crime incidents reported in these two places?',
    'Yes. Recent reports include pickpocketing in Dubrovnik, and isolated robbery and violent incidents in Zagreb; these are not evidence that tourists are generally being targeted, but keep valuables secure and take ordinary city precautions.',
  ],
  [
    'In Berlin on New Year’s Eve?',
    'Berlin is lively on New Year’s Eve, with parties and fireworks across the city, so expect crowds, noise, and busy transport. ' +
      /* MODELLED */ 'The biggest party is at the Brandenburg Gate, with stages and a fireworks show at midnight.',
  ],
  [
    'No. I- Bueno, buenas tardes.',
    'I’m not sure what you’d like to know about Berlin on New Year’s Eve. Could you say that again?',
  ],
  [
    'Like with the Brandon, Bakhtar, and all of those things, look it up, please.',
    'Berlin usually has a huge New Year’s Eve celebration, with music, crowds, and fireworks around the Brandenburg Gate. ' +
      /* MODELLED */ 'The party mile runs from the Gate to the Victory Column, and entry is free.',
  ],
  [
    'Yeah, yeah, I’d like to know more.',
    'For New Year’s Eve on the 31st of December, Berlin’s Brandenburg Gate party is listed, but the full programme and practical details may not be confirmed yet. ' +
      /* MODELLED */ 'The area fills up early, so arrive by the early evening.',
  ],
];

describe('call 8cb76efc F7: "Want more detail?" only now and then', () => {
  it('offers more on one of the call’s nine answers, not four, and never in place of one', async () => {
    const replies = ANSWERS.map(([, model]) => model);
    const { port } = searching(() => replies.shift() ?? 'Sure.');
    const agent = maya(port);
    const said: string[][] = [];
    for (const [index, [caller]] of ANSWERS.entries()) {
      agent.beginTurn(index + 1);
      const lines = await collect(agent.respondStream(caller, {}));
      for (const line of lines) agent.onPlayback(receipt(line, index + 1));
      said.push(lines);
    }
    const offers = new Set(DEFAULT_MORE_LINES);
    const ends = said.map((lines) => (offers.has(lines.at(-1)!) ? lines.at(-1) : '…'));
    // Before (b18b24e): "Want more detail?" after turn 13's "I’m sorry." in place of its answer,
    // then offers on turns 19, 25 and 28: four of nine, as live (13, 19, 25, 28, 30).
    // After: short tails are said (turns 19, 25, 28 and 30), and the offer comes once, on turn
    // 22, whose semicolon now ends a sentence the cap stops after.
    expect(ends).toEqual(['…', '…', '…', '…', 'Want more detail?', '…', '…', '…', '…']);
    expect(said[0]).toEqual([
      'You’re right, you did.',
      'I’m sorry.',
      'Zagreb grew from two medieval towns, Kaptol and Gradec, which joined in 1850 and became Croatia’s capital, a city of cafés and museums.',
    ]);
  });
});
