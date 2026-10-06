import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { staticSpeechInventory } from '../src/index.ts';

const agent = (transfer: Record<string, unknown>) =>
  AgentConfig.parse({
    name: 'Collections',
    mode: 'agent',
    handoff: { transfer: { target: { kind: 'phone', e164: '+918041234567' }, ...transfer } },
  });

describe('the transfer line in the clip inventory (AGT-15)', () => {
  it('pre-renders the line a fallback speaks before a transfer', () => {
    const inventory = staticSpeechInventory({
      config: agent({ line: 'Connecting you now.', onRecoveryExhausted: true }),
    });
    expect(inventory.static).toContainEqual({ text: 'Connecting you now.', source: 'recovery' });
  });

  it('renders nothing for a transfer no fallback can speak', () => {
    const inventory = staticSpeechInventory({
      config: agent({ line: 'Connecting you now.', llmTool: true }),
    });
    expect(inventory.static.map((line) => line.text)).not.toContain('Connecting you now.');
  });
});
