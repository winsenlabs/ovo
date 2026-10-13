import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { staticSpeechInventory } from '../src/index.ts';

describe('collections compliance lines in the clip inventory', () => {
  it('pre-renders the recording disclosure and the opt-out closing line', () => {
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      compliance: {
        disclosure: { text: 'Please note that this call is recorded for quality purposes.' },
        optOut: { closingLine: "Understood. We won't call again. Goodbye." },
      },
    });
    const lines = staticSpeechInventory({ config }).static.filter((line) =>
      ['disclosure', 'opt-out'].includes(line.source),
    );
    expect(lines).toEqual([
      {
        text: 'Please note that this call is recorded for quality purposes.',
        source: 'disclosure',
      },
      { text: "Understood. We won't call again. Goodbye.", source: 'opt-out' },
    ]);
  });

  it('leaves a disabled opt-out and an agent without compliance out', () => {
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      compliance: { optOut: { enabled: false } },
    });
    expect(
      staticSpeechInventory({ config }).static.some((line) =>
        ['disclosure', 'opt-out'].includes(line.source),
      ),
    ).toBe(false);
  });

  it('pre-renders the wrap-up line said before the call time limit', () => {
    const line = "I'm sorry, we need to end the call now. Thank you, goodbye.";
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      ending: { wrapUp: { line } },
    });
    expect(
      staticSpeechInventory({ config }).static.filter((entry) => entry.source === 'wrap-up'),
    ).toEqual([{ text: line, source: 'wrap-up' }]);
  });
});

describe('Wave 10 (L2): the lines around "Shall I end the call?" in the clip inventory', () => {
  it('pre-renders the question and the answers to a plain yes or no, with the LLM’s end_call', () => {
    const config = AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      language: 'en-IN',
      ending: { llmTool: true },
    });
    expect(
      staticSpeechInventory({ config }).static.filter((line) => line.source === 'ending'),
    ).toEqual([
      { text: 'Shall I end the call?', source: 'ending' },
      { text: 'Thank you for your time. Goodbye!', source: 'ending' },
      { text: 'Sure. What else can I help you with?', source: 'ending' },
    ]);
  });

  it('has none without the end_call tool, or in a language without the lines', () => {
    for (const config of [
      AgentConfig.parse({ name: 'Maya', mode: 'agent' }),
      AgentConfig.parse({ name: 'Maya', mode: 'agent', language: 'ta', ending: { llmTool: true } }),
    ])
      expect(
        staticSpeechInventory({ config }).static.some((line) => line.source === 'ending'),
      ).toBe(false);
  });
});
