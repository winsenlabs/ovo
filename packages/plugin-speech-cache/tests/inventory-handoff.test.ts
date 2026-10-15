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

describe('agent-to-agent transfer lines in the clip inventory (R2)', () => {
  const config = (agents: Record<string, unknown>) =>
    AgentConfig.parse({
      name: 'Sales',
      mode: 'agent',
      variables: {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      handoff: { agents },
    });

  it('pre-renders the transfer and return lines and keeps a templated greeting per call', () => {
    const inventory = staticSpeechInventory({
      config: config({
        llmTool: true,
        line: 'Let me move you to the right colleague.',
        inbound: { greeting: 'line', line: 'Hi {{name}}, billing here.', returnLine: "I'm back." },
      }),
    });
    expect(inventory.static).toContainEqual({
      text: 'Let me move you to the right colleague.',
      source: 'recovery',
    });
    expect(inventory.static).toContainEqual({ text: "I'm back.", source: 'recovery' });
    expect(inventory.perCall).toContainEqual({
      text: 'Hi {{name}}, billing here.',
      source: 'recovery',
    });
  });

  it('adds nothing for an agent without transfer lines', () => {
    const before = staticSpeechInventory({ config: config({}) });
    expect(before.static.map((line) => line.source)).not.toContain('transfer');
    expect(staticSpeechInventory({ config: config({ llmTool: true }) })).toEqual(before);
  });
});
