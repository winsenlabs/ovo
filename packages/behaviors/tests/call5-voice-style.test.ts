import { describe, expect, it } from 'vitest';
import { AgentConfig } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { voiceStyleNote } from '../src/inference-request.ts';
import { execution, llm } from './agent-call-control-fixture.ts';

/**
 * Wave 9 D1, Maya call 10d5ef30: the model wrote "Chennai–Prague", "21–24 Dec 2026" and
 * "€70–100/night", read out by TTS as written. plugin-voice's speech normaliser rewrites them on
 * the way to TTS; this note asks the model to write for the ear in the first place.
 */
describe('the write-for-the-ear note (call 10d5ef30 D1)', () => {
  it('asks English agents for ranges with "to", dates day first and no assumed year', () => {
    const note = voiceStyleNote({ language: 'en-IN' })!;
    expect(note).toContain('say ranges with "to"');
    expect(note).toContain('say dates day first ("the 21st of December")');
    expect(note).toContain('leave out the year unless the date is more than a year away');
  });

  it('leaves day-first dates out for en-US, and the note out for other languages', () => {
    expect(voiceStyleNote({ language: 'en-US' })).not.toContain('day first');
    expect(voiceStyleNote({ language: 'en-US' })).toContain('say ranges with "to"');
    expect(voiceStyleNote({ language: 'hi-IN' })).toBeUndefined();
  });

  it('goes into every English agent turn after the briefing', async () => {
    const { port, requests } = llm([{ kind: 'text', text: 'Hi.' }]);
    const agent = new AgentBehavior(
      AgentConfig.parse({ name: 'Maya', mode: 'agent', context: 'Briefing.' }),
      port,
      execution,
      { workspaceId: 'w', sessionId: 's' },
    );
    await agent.respond('Chennai to Prague, the 21st to the 24th?');
    expect(requests[0]!.context).toBe(`Briefing.\n\n${voiceStyleNote({ language: 'en-IN' })}`);
  });
});
