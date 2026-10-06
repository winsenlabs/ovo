import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { agentTemplates } from '../src/index.ts';

describe('the transfer line among the agent templates (AGT-15)', () => {
  it('is checked like any spoken line once a fallback can speak it', () => {
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      handoff: {
        transfer: {
          target: { kind: 'queue', name: 'collections' },
          line: 'Connecting you, {{name}}.',
          onDecisionUnavailable: true,
        },
      },
    });
    expect(agentTemplates(config)).toContainEqual({
      field: 'handoff.transfer.line',
      template: 'Connecting you, {{name}}.',
      spoken: true,
    });
  });
});
