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
