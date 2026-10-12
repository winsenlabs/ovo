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

  it('Wave 8b: restores it opening a sentence before a comma (call e8a43f65)', () => {
    const maya = agentNameRestorer({ agentName: 'Maya', agentNameMishearings: ["Ma'am", 'Mam'] })!;
    expect(maya("Ma'am, create a call.")).toBe('Maya, create a call.');
    expect(maya('Ma’am, cut the call.')).toBe('Maya, cut the call.');
    expect(maya('Okay. Mam, one more thing.')).toBe('Okay. Maya, one more thing.');
    expect(maya("Thank you, ma'am.")).toBe('Thank you, Maya.');
    // Not in address: mid-sentence, or with no comma after it.
    for (const text of ["Ma'am said so.", "I told the ma'am, yes.", 'Mammals, mostly.'])
      expect(maya(text)).toBe(text);
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
