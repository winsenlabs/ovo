import { describe, expect, it } from 'vitest';
import { meterApplies } from '@winsendotai/ovo-contracts';
import { manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import { openAiInferencePlugin } from '../src/index.ts';
import { openAiInference } from '../src/inference.ts';
import { enabled, lookup, plain, request, scriptedNet } from './web-search-fixtures.ts';

const ID = openAiInferencePlugin.manifest.id;

describe('web search binding schema', () => {
  const registry = new PluginRegistry([openAiInferencePlugin]);
  const valid = (config: unknown) => registry.validateBinding(ID, config).ok;

  it('accepts the documented shape and leaves it optional', () => {
    expect(valid({ model: 'gpt-6-luna' })).toBe(true);
    expect(valid({ model: 'gpt-6-luna', webSearch: { enabled: false } })).toBe(true);
    expect(
      valid({
        model: 'gpt-6-luna',
        api: 'responses',
        webSearch: {
          enabled: true,
          searchContextSize: 'medium',
          userLocation: {
            country: 'IN',
            city: 'Bengaluru',
            region: 'Karnataka',
            timezone: 'Asia/Kolkata',
          },
          allowedDomains: ['imd.gov.in', 'weather.com'],
        },
      }),
    ).toBe(true);
  });

  it('rejects a misspelt, incomplete or out-of-range web search config', () => {
    for (const webSearch of [
      {},
      { enabled: 'yes' },
      { enabled: true, searchContextSize: 'max' },
      { enabled: true, contextSize: 'low' },
      { enabled: true, userLocation: { country: 'India' } },
      { enabled: true, userLocation: { country: 'IN', type: 'approximate' } },
      { enabled: true, userLocation: { timezone: 'IST +5:30' } },
      { enabled: true, allowedDomains: ['https://imd.gov.in'] },
      { enabled: true, allowedDomains: [] },
    ])
      expect(valid({ model: 'gpt-6-luna', webSearch }), JSON.stringify(webSearch)).toBe(false);
  });

  it('refuses web search on anything but the Responses API with a clear error', async () => {
    expect(valid({ model: 'gpt-6-luna', api: 'chat', webSearch: { enabled: true } })).toBe(false);
    const ctx = {
      secret: async () => 'fixture-key',
      net: scriptedNet(plain).net,
      maybe: () => undefined,
      provide: () => undefined,
    };
    await expect(
      openAiInferencePlugin.apply(ctx as never, {
        binding: { model: 'gpt-6-luna', api: 'chat', webSearch: { enabled: true } },
      }),
    ).rejects.toThrow(/web search needs the Responses API/);
  });
});

describe('web search tool wiring', () => {
  it('sends no provider tool when web search is off', async () => {
    for (const binding of [
      { model: 'gpt-6-luna' },
      { model: 'gpt-6-luna', webSearch: { enabled: false } },
    ]) {
      const { net, bodies } = scriptedNet(plain);
      await openAiInference(net, 'fixture-key', binding).generate(request());
      expect(bodies[0]!.tools).toBeUndefined();
      expect(JSON.stringify(bodies[0]!.input)).not.toContain('web search');
    }
  });

  it('sends web_search (low context by default) beside OVO tools, keeping voice tuning', async () => {
    const { net, bodies } = scriptedNet(plain);
    await openAiInference(net, 'fixture-key', enabled, undefined, undefined, {
      bindingId: 'binding-1',
    }).generate(request([lookup]));
    const body = bodies[0]!;
    expect(body.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'lookup_ticket' }),
      { type: 'web_search', search_context_size: 'low' },
    ]);
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      reasoning: { effort: 'none' },
      store: false,
      prompt_cache_key: 'ovo:binding-1',
    });
    expect(JSON.stringify(body.input)).toContain('the results of your web search tool');
  });

  it('passes the configured context size, location and domain filter through', async () => {
    const { net, bodies } = scriptedNet(plain);
    await openAiInference(net, 'fixture-key', {
      model: 'gpt-6-luna',
      webSearch: {
        enabled: true,
        searchContextSize: 'high',
        userLocation: { country: 'IN', city: 'Bengaluru', timezone: 'Asia/Kolkata' },
        allowedDomains: ['imd.gov.in'],
      },
    }).generate(request());
    expect(bodies[0]!.tools).toEqual([
      {
        type: 'web_search',
        search_context_size: 'high',
        user_location: {
          type: 'approximate',
          country: 'IN',
          city: 'Bengaluru',
          timezone: 'Asia/Kolkata',
        },
        filters: { allowed_domains: ['imd.gov.in'] },
      },
    ]);
  });

  it('still returns an OVO tool call when web search is on', async () => {
    const call = () =>
      new Response(
        JSON.stringify({
          id: 'resp-2',
          created_at: 0,
          model: 'gpt-6-luna',
          output: [
            {
              type: 'function_call',
              id: 'fc-1',
              call_id: 'call-1',
              name: 'lookup_ticket',
              arguments: '{"id":"T-1"}',
            },
          ],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const { net } = scriptedNet(call);
    await expect(
      openAiInference(net, 'fixture-key', enabled).generate(request([lookup])),
    ).resolves.toMatchObject({ kind: 'tool', toolId: 'lookup_ticket', input: { id: 'T-1' } });
  });
});

describe('web search meter requirement', () => {
  const meters = manifestKeys(openAiInferencePlugin.manifest).manifest.meters ?? [];
  const required = (binding: Record<string, unknown>) =>
    meters.filter((meter) => meterApplies(meter, binding)).map((meter) => meter.key);

  it('is declared and needs a price card only from bindings that enable web search', () => {
    expect(meters.map((meter) => meter.key)).toContain('openai.inference.web_search_calls');
    for (const binding of [
      { model: 'gpt-6-luna' },
      { model: 'gpt-6-luna', webSearch: { enabled: false } },
    ]) {
      expect(required(binding)).not.toContain('openai.inference.web_search_calls');
      expect(required(binding)).toHaveLength(5);
    }
    expect(required(enabled as unknown as Record<string, unknown>)).toEqual([
      'openai.inference.input_tokens',
      'openai.inference.uncached_input_tokens',
      'openai.inference.cache_read_input_tokens',
      'openai.inference.cache_write_input_tokens',
      'openai.inference.output_tokens',
      'openai.inference.web_search_calls',
    ]);
  });
});
