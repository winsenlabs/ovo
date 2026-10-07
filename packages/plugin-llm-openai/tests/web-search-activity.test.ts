import { describe, expect, it } from 'vitest';
import type { InferenceStreamEvent } from '@winsendotai/ovo-contracts';
import { inferenceActivity, type InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import { openAiInferencePlugin } from '../src/index.ts';
import { openAiInference, type OpenAiInferenceConfig } from '../src/inference.ts';
import { DEFAULT_SEARCH_ANNOUNCEMENT, unclearForSearch } from '../src/search-voice.ts';
import { PluginRegistry } from '@winsendotai/ovo-runtime';
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

function setup(binding: OpenAiInferenceConfig = enabled) {
  const stepped = steppedNet();
  const inference = openAiInference(stepped.net, 'fixture-key', binding);
  const seen: { what: string; activity?: InferenceActivity }[] = [];
  inferenceActivity(inference)!.observeActivity((activity) =>
    seen.push({ what: `${activity.phase}:${activity.tool}`, activity }),
  );
  return { ...stepped, inference, seen };
}

/** Reads the stream in the background, logging text next to the activity it saw. */
function drain(events: AsyncIterable<InferenceStreamEvent>, log: { what: string }[]) {
  return (async () => {
    for await (const event of events)
      if (event.kind === 'text-delta') log.push({ what: `text:${event.delta}` });
  })();
}

const sentTools = (body: Record<string, unknown>) =>
  ((body.tools as { type: string }[] | undefined) ?? []).map((tool) => tool.type);

describe('the provider starting a web search is seen at once (N3)', () => {
  it('reports the start before the search returns, then its result count, then the answer', async () => {
    const { inference, seen, push, end } = setup();
    const done = drain(inference.stream(tripRequest('What is the weather in December?')), seen);
    await settle();
    push(created('resp-1') + searchAdded());
    await settle();
    // Only the provider's `output_item.added` has arrived: the search has not run yet.
    expect(seen.map((entry) => entry.what)).toEqual(['started:web_search']);
    expect(seen[0]!.activity).toMatchObject({
      id: 'ws-1',
      announce: DEFAULT_SEARCH_ANNOUNCEMENT,
    });
    push(searchDone('ws-1', 0, 4) + answer('About two degrees.') + completed('resp-1'));
    end();
    await done;
    expect(seen.map((entry) => entry.what)).toEqual([
      'started:web_search',
      'finished:web_search',
      'text:About two degrees.',
    ]);
    expect(seen[1]!.activity).toMatchObject({
      phase: 'finished',
      outcome: 'succeeded',
      action: 'search',
      results: 4,
      durationMs: expect.any(Number),
    });
  });

  it('reports nothing on a turn that answers without searching', async () => {
    const { inference, seen, push, end } = setup();
    const done = drain(inference.stream(tripRequest('Three days, I think.')), seen);
    await settle();
    push(created('resp-1') + answer('Lovely.', 0) + completed('resp-1'));
    end();
    await done;
    expect(seen.map((entry) => entry.what)).toEqual(['text:Lovely.']);
  });

  it('closes a search the turn abandoned as cancelled', async () => {
    const { inference, seen, push } = setup();
    const controller = new AbortController();
    const done = drain(
      inference.stream(tripRequest('Any vegetarian food there?', controller.signal)),
      seen,
    );
    await settle();
    push(created('resp-1') + searchAdded());
    await settle();
    controller.abort(new DOMException('barge-in', 'AbortError'));
    await expect(done).rejects.toThrow();
    expect(
      seen.map((entry) => [entry.what, (entry.activity as { outcome?: string })?.outcome]),
    ).toEqual([
      ['started:web_search', undefined],
      ['finished:web_search', 'cancelled'],
    ]);
  });

  it('carries the configured lines, or none when announcing is off', async () => {
    for (const [announce, expected] of [
      [
        { line: 'Ek second, dekh leti hoon.' },
        { ...DEFAULT_SEARCH_ANNOUNCEMENT, line: 'Ek second, dekh leti hoon.' },
      ],
      [false, undefined],
    ] as const) {
      const { inference, seen, push, end } = setup({
        model: 'gpt-6-luna',
        webSearch: { enabled: true, announce },
      });
      const done = drain(inference.stream(tripRequest('Is it cold in December?')), seen);
      await settle();
      push(created('resp-1') + searchAdded() + searchDone() + answer('Yes.') + completed('resp-1'));
      end();
      await done;
      expect((seen[0]!.activity as { announce?: unknown }).announce).toEqual(expected);
    }
  });

  it('validates the announcement in the binding', () => {
    const registry = new PluginRegistry([openAiInferencePlugin]);
    const valid = (webSearch: unknown) =>
      registry.validateBinding(openAiInferencePlugin.manifest.id, {
        model: 'gpt-6-luna',
        webSearch,
      }).ok;
    expect(valid({ enabled: true, announce: false, skipUnclearInput: false })).toBe(true);
    expect(valid({ enabled: true, announce: { stillAfterMs: 3000 } })).toBe(true);
    for (const announce of [true, { line: '' }, { stillAfterMs: 100 }, { lines: ['x'] }])
      expect(valid({ enabled: true, announce }), JSON.stringify(announce)).toBe(false);
  });
});

describe('no web search on input too unclear to search on (N3)', () => {
  // The Maya calls of 2026-10-07: each of these searched (3.8–4.3 s) or would have.
  const live = [
    ['No, no.', 'one-word'],
    ['Yes.', 'one-word'],
    ['Hey.', 'one-word'],
    ['Chilly. Chilly.', 'one-word'],
    ['हाँ।', 'one-word'],
    ["I don't know, tell me about-", 'cut-off'],
    ['Can you change your...', 'cut-off'],
    ['…', 'cut-off'],
    ['?!', 'no-words'],
  ] as const;

  it('classifies cut-off, empty and one-word turns, and leaves real questions to the model', () => {
    for (const [input, reason] of live)
      expect(unclearForSearch({ input, history: [] }), input).toBe(reason);
    for (const input of [
      'What would the weather be like?',
      'I am Indian vegetarian. Can I get food there?',
      'Okay. याद नहीं।',
      'Weather Zagreb',
    ])
      expect(unclearForSearch({ input, history: [] }), input).toBeUndefined();
  });

  it('lets a bare yes search when the agent had offered to look something up', () => {
    const offered = [{ role: 'assistant' as const, content: 'Shall I check the train times?' }];
    const asked = [{ role: 'assistant' as const, content: 'Is that Barcelona then Rome?' }];
    expect(unclearForSearch({ input: 'Yes.', history: offered })).toBeUndefined();
    expect(unclearForSearch({ input: 'Yes.', history: asked })).toBe('one-word');
  });

  it('sends the request without the search tool, so it cannot search', async () => {
    const { inference, bodies, push, end } = setup();
    for (const input of ['No, no.', 'What is the weather in December?']) {
      const done = drain(inference.stream(tripRequest(input)), []);
      await settle();
      push(created('resp') + answer('Okay.', 0) + completed('resp'));
      end();
      await done;
    }
    expect(bodies.map(sentTools)).toEqual([[], ['web_search']]);
    // The prompt only names web search as a source when the tool is there.
    expect(JSON.stringify(bodies[0])).not.toContain('web search tool');
    expect(JSON.stringify(bodies[1])).toContain('web search tool');
  });

  it('keeps the tool on every turn when the binding says so', async () => {
    const { inference, bodies, push, end } = setup({
      model: 'gpt-6-luna',
      webSearch: { enabled: true, skipUnclearInput: false },
    });
    const done = drain(inference.stream(tripRequest('No, no.')), []);
    await settle();
    push(created('resp') + answer('Okay.', 0) + completed('resp'));
    end();
    await done;
    expect(bodies.map(sentTools)).toEqual([['web_search']]);
  });
});
