import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageMeter } from '@winsendotai/ovo-contracts';
import {
  ABORTED_SEARCH_AFTER_MS,
  estimateInputTokens,
  WEB_SEARCH_SCAFFOLD_TOKENS,
} from '../src/aborted-usage.ts';
import { openAiInference } from '../src/inference.ts';
import {
  answer,
  completed,
  created,
  searchAdded,
  searchDone,
  settle,
  steppedNet,
  tripRequest,
} from './search-stream-fixtures.ts';
import { enabled } from './web-search-fixtures.ts';

function setup() {
  const meters: UsageMeter[] = [];
  const stepped = steppedNet();
  const inference = openAiInference(stepped.net, 'fixture-key', enabled, (meter) =>
    meters.push(meter),
  );
  const aborted = () =>
    Object.fromEntries(
      meters
        .filter((meter) => meter.state === 'estimated')
        .map((meter) => [meter.unit, Number(meter.quantity)]),
    );
  return { ...stepped, inference, meters, aborted };
}

/** Streams one request to completion. */
async function complete(
  { inference, push, end }: ReturnType<typeof setup>,
  input: string,
  reply: string,
) {
  const done = (async () => {
    for await (const _ of inference.stream(tripRequest(input)));
  })();
  await settle();
  push(reply);
  end();
  await done;
}

/** Starts a stream, lets `chunk` arrive, then aborts it as a barge-in would. */
async function abortAfter(h: ReturnType<typeof setup>, input: string, chunk = '') {
  const controller = new AbortController();
  const request = tripRequest(input, controller.signal);
  const done = (async () => {
    for await (const _ of h.inference.stream(request));
  })();
  await settle();
  if (chunk) h.push(chunk);
  await settle();
  controller.abort(new DOMException('barge-in', 'AbortError'));
  await expect(done).rejects.toThrow();
  return request;
}

afterEach(() => vi.useRealTimers());

describe('an aborted search-enabled call is metered at its real size (N6)', () => {
  it('adds the web search scaffolding a first request carries, not just its text', async () => {
    const h = setup();
    const request = await abortAfter(h, 'What is Zagreb like in winter?');
    const text = estimateInputTokens(request);
    // Live (call 50ac3860 turn 1) this was metered 389 tokens; its successor reported 4,827.
    expect(text).toBeLessThan(200);
    expect(h.aborted()).toEqual({
      input_tokens: text + WEB_SEARCH_SCAFFOLD_TOKENS,
      uncached_input_tokens: text + WEB_SEARCH_SCAFFOLD_TOKENS,
    });
  });

  it("estimates from the call's last reported request, cached share included", async () => {
    const h = setup();
    // Call 50ac3860 turn 2: 4,827 input tokens, 4,725 of them cached, no search.
    await complete(
      h,
      'Ik lieg niet.',
      created('resp-1') +
        answer('Ik geloof je.', 0) +
        completed('resp-1', { input: 4827, cached: 4725 }),
    );
    const overhead = 4827 - estimateInputTokens(tripRequest('Ik lieg niet.'));
    const request = await abortAfter(h, 'Nou, nou, Italy, English, English.');
    const input = estimateInputTokens(request) + overhead;
    expect(h.aborted()).toEqual({
      input_tokens: input,
      uncached_input_tokens: input - 4725,
      cache_read_input_tokens: 4725,
    });
    expect(input).toBeGreaterThan(4800);
  });

  it('never learns the overhead from a request whose search results inflated it', async () => {
    const h = setup();
    // Call bcbc7d6a turn 1: a search reply reported 8,781 input tokens, 4,012 of them results.
    await complete(
      h,
      'Can you tell me more about Zagreb?',
      created('resp-1') +
        searchAdded() +
        searchDone() +
        answer('Zagreb is lovely.') +
        completed('resp-1', { input: 8781, cached: 4725 }),
    );
    const request = await abortAfter(h, 'And the food?');
    expect(h.aborted().input_tokens).toBe(
      estimateInputTokens(request) + WEB_SEARCH_SCAFFOLD_TOKENS,
    );
  });

  it('meters the search an aborted stream had started, and none it had not', async () => {
    const h = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    await abortAfter(h, 'Where should we go for a short trip?', created('resp-1') + searchAdded());
    expect(h.aborted().web_search_calls).toBe(1);
    expect(h.meters.find((meter) => meter.unit === 'web_search_calls')).toMatchObject({
      state: 'estimated',
      requestId: 'openai:aborted:1',
    });

    const quiet = setup();
    const controller = new AbortController();
    const done = (async () => {
      for await (const _ of quiet.inference.stream(tripRequest('Three days.', controller.signal)));
    })();
    await settle();
    quiet.push(created('resp-2'));
    await settle();
    // Long past the threshold, but the stream says the model never asked for a search.
    vi.setSystemTime(Date.now() + ABORTED_SEARCH_AFTER_MS + 1000);
    controller.abort();
    await expect(done).rejects.toThrow();
    expect(quiet.aborted().web_search_calls).toBeUndefined();
  });

  it('meters one search for a generate aborted after the threshold, none before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const searches: (number | undefined)[] = [];
    for (const waitedMs of [ABORTED_SEARCH_AFTER_MS - 500, ABORTED_SEARCH_AFTER_MS + 500]) {
      const h = setup();
      const controller = new AbortController();
      const reply = h.inference.generate(tripRequest('What is on in Zagreb?', controller.signal));
      await settle();
      vi.setSystemTime(Date.now() + waitedMs);
      controller.abort();
      await expect(reply).rejects.toThrow();
      searches.push(h.aborted().web_search_calls);
    }
    expect(searches).toEqual([undefined, 1]);
  });

  it('meters no search scaffolding or search for an unclear turn sent without the tool', async () => {
    const h = setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const controller = new AbortController();
    const request = tripRequest('No, no.', controller.signal);
    const reply = h.inference.generate(request);
    await settle();
    vi.setSystemTime(Date.now() + ABORTED_SEARCH_AFTER_MS + 500);
    controller.abort();
    await expect(reply).rejects.toThrow();
    expect(h.aborted()).toEqual({
      input_tokens: estimateInputTokens(request),
      uncached_input_tokens: estimateInputTokens(request),
    });
  });
});
