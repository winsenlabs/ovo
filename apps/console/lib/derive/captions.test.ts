import { describe, expect, it } from 'vitest';
import { applyCaption, handoverConversation, liveConversation, MAX_CAPTION_LINES } from './captions';

describe('applyCaption', () => {
  it('replaces a speaker’s interim caption until it finalises', () => {
    let lines = applyCaption([], { role: 'caller', text: 'I want', final: false, at: 1_000 });
    lines = applyCaption(lines, { role: 'caller', text: 'I want to pay', final: false, at: 1_200 });
    expect(lines).toHaveLength(1);
    lines = applyCaption(lines, { role: 'caller', text: 'I want to pay my bill.', final: true, at: 1_800 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: 'I want to pay my bill.', final: true });
    lines = applyCaption(lines, { role: 'caller', text: 'Today', final: false, at: 2_000 });
    expect(lines).toHaveLength(2);
  });

  it('starts a new line when the other side speaks, even over an unfinished one', () => {
    let lines = applyCaption([], { role: 'caller', text: 'hello', final: false, at: 1 });
    lines = applyCaption(lines, { role: 'operator', text: 'Hi', final: true, at: 2 });
    expect(lines.map((line) => line.role)).toEqual(['caller', 'operator']);
  });

  it('keeps a bounded window of the newest lines', () => {
    let lines: ReturnType<typeof applyCaption> = [];
    for (let i = 0; i < MAX_CAPTION_LINES + 5; i += 1)
      lines = applyCaption(lines, { role: 'agent', text: String(i), final: true, at: i });
    expect(lines).toHaveLength(MAX_CAPTION_LINES);
    expect(lines.at(-1)?.text).toBe(String(MAX_CAPTION_LINES + 4));
  });
});

describe('conversation mapping', () => {
  it('times live captions from when the operator joined and flags interim lines', () => {
    const lines = liveConversation(
      [
        { id: 'a', role: 'operator', text: 'Hi', final: true, at: 5_000 },
        { id: 'b', role: 'caller', text: 'Hel', final: false, at: 3_000 },
      ],
      4_000,
    );
    expect(lines).toEqual([
      { id: 'a', speaker: 'operator', atMs: 1_000, text: 'Hi', interim: false },
      { id: 'b', speaker: 'caller', atMs: 0, text: 'Hel', interim: true },
    ]);
  });

  it('gives handover turns no clock', () => {
    expect(handoverConversation([{ role: 'agent', text: 'How can I help?' }])).toEqual([
      { id: 'handover-0', speaker: 'agent', text: 'How can I help?' },
    ]);
  });
});
