import { describe, expect, it } from 'vitest';
import { agentNameRestorer } from '../src/agent-name.ts';

// Wave 8, call 6e1a4e3a: the caller's "Thank you, Maya" was transcribed "Thank you, Danny".

describe("restoring the agent's misheard name", () => {
  const restore = agentNameRestorer({ agentName: 'Maya', agentNameMishearings: ['Danny', 'Mia'] })!;

  it('restores it where the caller addresses the agent', () => {
    expect(restore('Okay. Thank you, Danny.')).toBe('Okay. Thank you, Maya.');
    expect(restore('thank you so much, danny!')).toBe('thank you so much, Maya!');
    expect(restore('Hi Mia')).toBe('Hi Maya');
    expect(restore('Okay, Danny, one minute.')).toBe('Okay, Maya, one minute.');
    expect(restore('Haan ji, Mia?')).toBe('Haan ji, Maya?');
  });

  it('leaves the word alone anywhere else', () => {
    for (const text of [
      'Danny will pay tomorrow.',
      'I spoke to Danny.',
      'Thank you, Danny Boyle sent it.',
      'Thanks, Dannyboy.',
      'Hello, if madam...',
    ])
      expect(restore(text)).toBe(text);
  });

  it('does nothing without a name and a mishearing', () => {
    expect(agentNameRestorer({})).toBeUndefined();
    expect(agentNameRestorer({ agentName: 'Maya' })).toBeUndefined();
    expect(
      agentNameRestorer({ agentName: 'Maya', agentNameMishearings: ['maya'] }),
    ).toBeUndefined();
    expect(agentNameRestorer({ agentNameMishearings: ['Danny'] })).toBeUndefined();
  });
});
