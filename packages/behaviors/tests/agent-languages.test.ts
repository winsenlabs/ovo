import { describe, expect, it } from 'vitest';
import { agent, call, collect, llm, receipt } from './agent-call-control-fixture.ts';

const LANGUAGES = { languages: { allowed: ['en', 'hi'] }, ending: { llmTool: true } };
const LINE = 'Sorry, I can only understand English or Hindi. Could you say that again?';

describe('agent languages (N4/P9)', () => {
  it('asks a caller heard in Russian to say it again, and never lets the LLM end the call', async () => {
    // Call b1fd8b51: the first caller turn, misheard as Russian, got a Russian goodbye and end_call.
    const model = llm([
      { kind: 'tool', toolId: 'end_call', input: { goodbye: 'До свидания!', reason: 'done' } },
    ]);
    const { behavior } = agent(LANGUAGES, { llm: model });
    behavior.beginTurn(2);
    expect(await collect(behavior.respondStream('Нет, это всё.', call))).toEqual([LINE]);
    expect(model.requests).toHaveLength(0);
    behavior.onPlayback(receipt(LINE, 2));
    expect(behavior.isComplete()).toBe(false);
    expect(behavior.languageMetrics).toMatchObject({ offTurns: 1 });
  });

  it('answers code-mixed Hinglish through the LLM as usual', async () => {
    const model = llm([{ kind: 'text', text: 'Sure, I will note that.' }]);
    const { behavior } = agent(LANGUAGES, { llm: model });
    behavior.beginTurn(1);
    expect(await behavior.respond('मुझे नोट करिए, can you say the number again?', call)).toBe(
      'Sure, I will note that.',
    );
    expect(model.requests).toHaveLength(1);
  });

  it('pins the reply language in the platform instructions, not the persona prompt', async () => {
    const model = llm([{ kind: 'text', text: 'Okay.' }]);
    const { behavior } = agent(LANGUAGES, { llm: model });
    behavior.beginTurn(1);
    await behavior.respond('hello', call);
    expect(model.requests[0]!.context).toContain(
      'Always reply in English, the language of this call, whatever language the caller uses.',
    );
    const plain = llm([{ kind: 'text', text: 'Okay.' }]);
    const { behavior: without } = agent({}, { llm: plain });
    without.beginTurn(1);
    await without.respond('hello', call);
    expect(plain.requests[0]!.context).not.toContain('Always reply in');
  });

  it('replaces a drifted streamed reply with the line and withdraws its end_call', async () => {
    const model = llm([
      [
        { kind: 'text-delta', delta: 'Хорошо, спасибо за звонок. Хорошей поездки!' },
        { kind: 'tool', toolId: 'end_call', input: { goodbye: 'unused' } },
        { kind: 'finish' },
      ],
    ]);
    const { behavior } = agent(LANGUAGES, { llm: model });
    behavior.beginTurn(3);
    expect(await collect(behavior.respondStream('okay thanks', call))).toEqual([LINE]);
    behavior.onPlayback(receipt(LINE, 3));
    expect(behavior.isComplete()).toBe(false);
    expect(behavior.languageMetrics).toEqual({
      offTurns: 0,
      replacedReplies: 1,
      droppedSegments: 1,
    });
  });

  it('changes nothing for an agent without languages', async () => {
    const model = llm([{ kind: 'text', text: 'Хорошо.' }]);
    const { behavior } = agent({}, { llm: model });
    behavior.beginTurn(1);
    expect(await behavior.respond('Нет, это всё.', call)).toBe('Хорошо.');
  });
});
