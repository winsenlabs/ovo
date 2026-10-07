import { describe, expect, it } from 'vitest';
import type { InferenceStreamEvent, UsageMeter } from '@winsendotai/ovo-contracts';
import { openAiInference } from '../src/inference.ts';
import { StreamingCitationStripper, stripCitations, webSearchUsage } from '../src/web-search.ts';
import { enabled, plain, request, scriptedNet, sse } from './web-search-fixtures.ts';

const CITED =
  'Bengaluru is 24 degrees and sunny today ([weather.com](https://weather.com/en-IN/today?utm_source=openai)). Rain is likely tonight【3†source】 [1].';
const SPOKEN = 'Bengaluru is 24 degrees and sunny today. Rain is likely tonight.';

/** A completed Responses JSON body: one search call, one cited answer. */
const searched = () =>
  new Response(
    JSON.stringify({
      id: 'resp-ws-1',
      created_at: 0,
      model: 'gpt-6-luna',
      output: [
        {
          type: 'web_search_call',
          id: 'ws-1',
          status: 'completed',
          action: { type: 'search', query: 'Bengaluru weather today' },
        },
        {
          type: 'message',
          role: 'assistant',
          id: 'msg-1',
          content: [
            {
              type: 'output_text',
              text: CITED,
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://weather.com/en-IN/today?utm_source=openai',
                  title: 'Weather',
                  start_index: 40,
                  end_index: 104,
                },
              ],
            },
          ],
        },
      ],
      usage: { input_tokens: 900, output_tokens: 20, total_tokens: 920 },
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req-ws-1' } },
  );

/** The streamed version: a billed search, an unbilled open_page, then an answer split mid-citation. */
const streamed = () => {
  const deltas = [
    'Bengaluru is 24 degrees and sunny today (',
    '[weather.com](https://weather',
    '.com/en-IN/today?utm_source=openai)). Rain is likely tonight【3',
    '†source】 [',
    '1]. See https://imd.gov',
    '.in/forecast for more.',
  ];
  return new Response(
    sse({
      type: 'response.created',
      response: { id: 'resp-ws-2', created_at: 0, model: 'gpt-6-luna' },
    }) +
      sse({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'web_search_call', id: 'ws-1', status: 'in_progress' },
      }) +
      sse({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'web_search_call',
          id: 'ws-1',
          status: 'completed',
          action: { type: 'search', query: 'Bengaluru weather today' },
        },
      }) +
      sse({
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'web_search_call', id: 'ws-2', status: 'in_progress' },
      }) +
      sse({
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'web_search_call',
          id: 'ws-2',
          status: 'completed',
          action: { type: 'open_page', url: 'https://weather.com/en-IN/today' },
        },
      }) +
      sse({
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'message', id: 'msg-2' },
      }) +
      deltas
        .map((delta) =>
          sse({ type: 'response.output_text.delta', item_id: 'msg-2', output_index: 2, delta }),
        )
        .join('') +
      sse({
        type: 'response.completed',
        response: {
          id: 'resp-ws-2',
          usage: { input_tokens: 900, output_tokens: 20, total_tokens: 920 },
        },
      }),
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-ws-2' } },
  );
};

describe('web search answers are spoken without citations', () => {
  it('strips citation groups, markers, links and URLs', () => {
    expect(stripCitations(CITED)).toBe(SPOKEN);
    expect(
      stripCitations(
        'It opens at nine ([a.com](https://a.com/x), [b.org](https://b.org/y)); call [the desk](https://a.com/desk) or visit https://www.example.com/hours?ref=1 today.',
      ),
    ).toBe('It opens at nine; call the desk or visit example.com today.');
    // Ordinary brackets are speech, not citations.
    expect(stripCitations('Two (maybe three) people [roughly] came.')).toBe(
      'Two (maybe three) people [roughly] came.',
    );
  });

  it('holds a citation split across deltas until it can be removed whole', () => {
    const stripper = new StreamingCitationStripper();
    const parts = [
      'Sunny today (',
      '[weather.com](https://wea',
      'ther.com/a)). Rain【3',
      '†source】 later [',
      '1]. See http',
      's://imd.gov.in/x now.',
    ].map((delta) => stripper.push(delta));
    parts.push(stripper.finish());
    expect(parts.join('')).toBe('Sunny today. Rain later. See imd.gov.in now.');
    // Nothing that is not part of a possible citation waits.
    expect(new StreamingCitationStripper().push('Hello there, ')).toBe('Hello there,');
  });

  it('releases an unclosed bracket rather than muting the reply', () => {
    const stripper = new StreamingCitationStripper();
    expect(stripper.push('Note (this never closes')).toBe('Note');
    expect(stripper.finish()).toBe(' (this never closes');
    expect(new StreamingCitationStripper().push(`(${'x'.repeat(700)}`)).toHaveLength(701);
  });

  it('streams a cited answer as clean speech and meters only the billed search', async () => {
    const meters: UsageMeter[] = [];
    const { net } = scriptedNet(streamed);
    const events: InferenceStreamEvent[] = [];
    for await (const event of openAiInference(net, 'fixture-key', enabled, (meter) =>
      meters.push(meter),
    ).stream(request()))
      events.push(event);
    const text = events
      .flatMap((event) => (event.kind === 'text-delta' ? [event.delta] : []))
      .join('');
    expect(text).toBe(
      'Bengaluru is 24 degrees and sunny today. Rain is likely tonight. See imd.gov.in for more.',
    );
    expect(text).not.toMatch(/https?:|\]\(|【|\[\d/);
    expect(events.some((event) => event.kind === 'tool')).toBe(false);
    expect(events.at(-1)?.kind).toBe('finish');
    // One search; the open_page action of the second call is not a billed search.
    expect(meters.filter((meter) => meter.unit === 'web_search_calls')).toEqual([
      {
        provider: 'openai',
        operation: 'inference',
        unit: 'web_search_calls',
        quantity: '1',
        state: 'reconciled',
        requestId: 'req-ws-2',
        elapsedMs: expect.any(Number),
      },
    ]);
    expect(meters.map((meter) => meter.unit)).toContain('input_tokens');
  });

  it('generates a cited answer as clean speech and meters its search', async () => {
    const meters: UsageMeter[] = [];
    const { net } = scriptedNet(searched);
    const reply = await openAiInference(net, 'fixture-key', enabled, (meter) =>
      meters.push(meter),
    ).generate(request());
    expect(reply).toMatchObject({ kind: 'text', text: SPOKEN });
    expect(meters.find((meter) => meter.unit === 'web_search_calls')).toMatchObject({
      quantity: '1',
      requestId: 'req-ws-1',
      state: 'reconciled',
    });
  });

  it('records no web search meter when the reply did not search', async () => {
    const meters: UsageMeter[] = [];
    const { net } = scriptedNet(plain);
    await openAiInference(net, 'fixture-key', enabled, (meter) => meters.push(meter)).generate(
      request(),
    );
    expect(meters.some((meter) => meter.unit === 'web_search_calls')).toBe(false);
    expect(meters.length).toBeGreaterThan(0);
  });

  it('counts searches and calls with no reported action, not page opens', () => {
    expect(
      webSearchUsage([
        { toolName: 'web_search', output: { action: { type: 'search' } } },
        { toolName: 'web_search', output: {} },
        { toolName: 'web_search', output: { action: { type: 'openPage' } } },
        { toolName: 'web_search', output: { action: { type: 'findInPage' } } },
        { toolName: 'other', output: {} },
      ]),
    ).toEqual([{ unit: 'web_search_calls', quantity: 2 }]);
    expect(webSearchUsage([])).toEqual([]);
  });
});
