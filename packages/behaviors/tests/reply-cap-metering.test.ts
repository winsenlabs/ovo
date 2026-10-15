import { describe, expect, it } from 'vitest';
import type { UsageMeter } from '@winsendotai/ovo-contracts';
import { streamAgentReply } from '../src/agent-stream.ts';
import { openAiInference } from '../../plugin-llm-openai/src/inference.ts';
import {
  answer,
  completed,
  created,
  searchAdded,
  searchDone,
  settle,
  steppedNet,
  tripRequest,
} from '../../plugin-llm-openai/tests/search-stream-fixtures.ts';
import { enabled } from '../../plugin-llm-openai/tests/web-search-fixtures.ts';

describe('call-3 #7: a capped answer is still metered', () => {
  // The cap fires mostly on search answers (~4.8k input tokens plus the search fee each). Closing
  // the provider's stream early, without an abort, reached neither the `finish` that carries the
  // real usage nor the aborted-request estimate: the ledger recorded nothing for the turn.
  it('meters the real usage of a search answer the caller heard only the start of', async () => {
    const meters: UsageMeter[] = [];
    const { net, push, end } = steppedNet();
    const inference = openAiInference(net, 'fixture-key', enabled, (meter) => meters.push(meter));
    const said: string[] = [];
    const done = (async () => {
      for await (const line of streamAgentReply(
        inference.stream(tripRequest('What is Zagreb like?')),
        'en-IN',
        () => undefined,
        (text) => text,
        undefined,
        undefined,
        undefined,
        'en-IN',
      ))
        said.push(line);
    })();
    await settle();
    push(
      created('resp-1') +
        searchAdded() +
        searchDone() +
        answer(
          'Zagreb is the capital of Croatia. It has a lovely upper town with old streets. ' +
            'The market is great. The museums are worth a morning.' +
            ' The cathedral and the funicular are a short walk from the main square.',
        ) +
        completed('resp-1', { input: 4827, cached: 4725, output: 40 }),
    );
    end();
    await done;
    expect(said.join(' ')).toBe(
      'Zagreb is the capital of Croatia. It has a lovely upper town with old streets. Want more detail?',
    );
    const reported = meters.filter((meter) => meter.state !== 'estimated');
    expect(Number(reported.find((meter) => meter.unit === 'input_tokens')?.quantity)).toBe(4827);
    expect(reported.some((meter) => meter.unit === 'web_search_calls')).toBe(true);
  });
});
