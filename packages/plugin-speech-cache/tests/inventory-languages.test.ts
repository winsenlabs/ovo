import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { staticSpeechInventory } from '../src/index.ts';

const lines = (raw: Record<string, unknown>) =>
  staticSpeechInventory({
    config: AgentConfig.parse({ name: 'Collections', mode: 'agent', ...raw }),
  }).static.map((line) => line.text);

describe('the language line in the clip inventory (N4)', () => {
  it('pre-renders the default line of an agent with languages', () => {
    expect(lines({ languages: { allowed: ['en', 'hi'] } })).toContain(
      'Sorry, I can only understand English or Hindi. Could you say that again?',
    );
  });

  it('pre-renders an authored line, and nothing for an agent without languages', () => {
    expect(lines({ languages: { allowed: ['en'], line: 'Pardon, in English please?' } })).toContain(
      'Pardon, in English please?',
    );
    expect(lines({}).some((text) => text.startsWith('Sorry, I can only understand'))).toBe(false);
  });
});

describe('the ask-again lines in the clip inventory (call-3 #3)', () => {
  it("pre-renders the language's defaults, or the agent's own lines", () => {
    expect(lines({ language: 'hi-IN' })).toContain('माफ़ कीजिए, क्या आप फिर से बता सकते हैं?');
    expect(lines({ unclear: { lines: ['Pardon?'] } })).toContain('Pardon?');
    expect(lines({ unclear: { lines: ['Pardon?'] } })).not.toContain(
      'Sorry, could you say that again?',
    );
  });
});
