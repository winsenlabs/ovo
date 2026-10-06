import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { ScriptBehavior } from '../src/index.ts';

const config = AgentConfig.parse({
  name: 'Reminder',
  mode: 'announcement',
  script: {
    start: 'ask',
    nodes: [
      {
        id: 'ask',
        prompt: 'Shall I send the link?',
        transitions: [{ event: 'text', matches: ['yes'], to: 'sent' }],
      },
      { id: 'sent', prompt: 'Sent.', terminal: true },
    ],
  },
});

describe('a script and the turn driver’s speculation hooks (LAT-4)', () => {
  it('has no `prepare` for the driver to call with a partial transcript', async () => {
    // The driver reads `prepare` structurally; a private method of that name used to receive the
    // partial as a node id and throw on every partial of every script call.
    const behavior = new ScriptBehavior(config) as unknown as Record<string, unknown>;
    expect(behavior['prepare']).toBeUndefined();
    const script = behavior as unknown as ScriptBehavior;
    script.beginTurn(0);
    expect(await script.respond('')).toBe('Shall I send the link?');
  });
});
