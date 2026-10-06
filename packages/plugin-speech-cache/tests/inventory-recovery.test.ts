import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { staticSpeechInventory } from '../src/index.ts';

describe('agent idle and recovery lines in the clip inventory (AGT-11, AGT-12)', () => {
  it('pre-renders fixed idle and recovery lines and keeps templated ones per call', () => {
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      variables: { type: 'object', properties: { name: { type: 'string' } } },
      decision: {
        enabled: true,
        state: { sources: ['last-turn'] },
        questions: [
          {
            id: 'intent',
            type: 'choice',
            instructions: 'What do they want?',
            threshold: 0.6,
            fallback: 'clarify',
            options: [
              { key: 'pay', description: 'Will pay', outcome: { say: 'Thank you.' } },
              { key: 'bye', description: 'Bye', outcome: { say: 'Goodbye.', end: true } },
            ],
          },
        ],
      },
      idle: { prompts: ['Hello? Can you hear me?', 'Are you there, {{name}}?'] },
      recovery: { reprompts: { intent: 'When can you pay?' }, repeat: {} },
      decisionUnavailable: { line: 'Sorry, one moment.' },
    });
    const inventory = staticSpeechInventory({ config });
    expect(
      inventory.static.filter((line) => ['idle-prompt', 'recovery'].includes(line.source)),
    ).toEqual([
      { text: 'Hello? Can you hear me?', source: 'idle-prompt' },
      { text: "Sorry, I didn't quite catch that. Could you say that again?", source: 'recovery' },
      { text: 'When can you pay?', source: 'recovery' },
      { text: 'Sure, let me repeat that.', source: 'recovery' },
      {
        text: "I'm having trouble understanding, so I'll call back later. Goodbye.",
        source: 'recovery',
      },
      { text: 'Sorry, one moment.', source: 'recovery' },
    ]);
    expect(inventory.perCall).toContainEqual({
      text: 'Are you there, {{name}}?',
      source: 'idle-prompt',
    });
  });
});
