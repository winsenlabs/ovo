import { describe, expect, it } from 'vitest';
import type { InferenceRequest } from '@winsendotai/ovo-contracts';
import { buildSystemPrompt } from '../src/ai-sdk-support.ts';

const request: InferenceRequest = {
  input: 'हाँ।',
  context: 'You are Maya.',
  uncertainty: "I'm not completely sure about that. Want me to look it up?",
  tools: [],
  results: [],
  signal: new AbortController().signal,
};

describe('the system prompt (call-3 #3)', () => {
  it('keeps the uncertainty line for unsupported asks, never for unclear words', () => {
    const prompt = buildSystemPrompt(request);
    expect(prompt).toContain(
      "When the caller asks for a fact these sources do not support, respond exactly with: I'm not completely sure about that. Want me to look it up?",
    );
    expect(prompt).toContain('Ask them to say it again only when you cannot make out their words.');
  });

  it('carries on from plans, answers and a yes, and lets cut-off words go on (call 8cb76efc F1)', () => {
    const prompt = buildSystemPrompt(request);
    // Before: "…words that are unclear, cut off or ask for nothing: ask the caller to say it again
    // instead." Live: the line for "Jan 12th, 2024.", "Sorry, could you say that again?" for
    // "Yeah." and "Could you finish your question?" for "No. Have there been any-".
    expect(prompt).not.toContain('ask for nothing: ask the caller');
    expect(prompt).toContain(
      'When the caller tells you their plans or dates, answers your question, or says yes to what you offered, carry on from what they said.',
    );
    expect(prompt).toContain(
      'When their words break off unfinished, answer what they did ask, or invite them to go on in a few words.',
    );
  });

  it('adds a provider tool’s instructions only with its sources', () => {
    const how = 'Search at most once.';
    expect(buildSystemPrompt(request, undefined, undefined, how)).not.toContain(how);
    const prompt = buildSystemPrompt(request, 'Be brief.', 'web search results', how);
    expect(prompt).toContain(
      'Use only the supplied context, completed operation results and web search results as factual sources.\n\nSearch at most once.',
    );
    expect(prompt.startsWith('Be brief.')).toBe(true);
  });
});
