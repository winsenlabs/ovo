import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Inference, InferenceRequest } from '@winsendotai/ovo-contracts';
import { DEFAULT_SPECULATION, type LlmSpeculationMetrics } from '../src/index.ts';
import type { InferenceCall } from '../src/speculation-llm.ts';
import { PartialLlmSpeculation } from '../src/speculation-partial.ts';

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

/** An LLM that sends its web search tool to words with a question mark, as a guard might. */
function searchingLlm(sends: (input: string) => boolean = (input) => input.includes('?')) {
  const asked: InferenceRequest[] = [];
  const port: Inference = {
    generate: () => Promise.reject(new Error('streamed only')),
    async *stream(request) {
      asked.push(request);
      yield { kind: 'finish' };
    },
    sendsProviderTools: (request) => sends(request.input),
  };
  return { port, asked };
}

const request = (input: string): InferenceCall => ({
  input,
  history: [],
  context: 'Maya',
  uncertainty: 'unsure',
  tools: [],
  results: [],
});

/**
 * Wave 8b, call e8a43f65 issue 4: a speculative call asked on a partial transcript the caller then
 * carried on (or changed) is thrown away, and a web search it started was billed for nothing.
 */
describe('no web search is started on words the STT may still revise', () => {
  async function offer(text: string, stable: boolean, port = searchingLlm()) {
    const metrics: LlmSpeculationMetrics = {
      started: 0,
      used: 0,
      aborted: 0,
      discarded: 0,
      onPartials: 0,
    };
    const speculation = new PartialLlmSpeculation(DEFAULT_SPECULATION, port.port, metrics);
    speculation.offer('u-1', text, stable, () => request(text));
    await vi.advanceTimersByTimeAsync(DEFAULT_SPECULATION.llmDebounceMs + 10);
    return { asked: port.asked.map((r) => r.input), metrics, take: () => speculation.take() };
  }

  it('leaves a revisable partial the LLM would search on for the turn to ask', async () => {
    const r = await offer('Is the Christmas market open on the 25th?', false);
    expect(r.asked).toEqual([]);
    expect(r.metrics.onPartials).toBe(0);
    expect(r.take()).toBeUndefined();
  });

  it('still asks ahead on words it would not search on, and on final words', async () => {
    expect((await offer('I want 21st of December to the 5th.', false)).asked).toEqual([
      'I want 21st of December to the 5th.',
    ]);
    expect((await offer('Is the Christmas market open on the 25th?', true)).asked).toEqual([
      'Is the Christmas market open on the 25th?',
    ]);
  });

  it('asks ahead on words sent the tool that ask nothing, as most never search (review)', async () => {
    // Maya's guard sends the tool to most multi-word turns; only a question waits for final words.
    const port = () => searchingLlm(() => true);
    expect((await offer('And in Split.', false, port())).asked).toEqual(['And in Split.']);
    expect((await offer('Tell me about Split.', false, port())).asked).toEqual([]);
    expect((await offer('Is the Christmas market open on the 25th?', false, port())).asked).toEqual(
      [],
    );
  });
});
