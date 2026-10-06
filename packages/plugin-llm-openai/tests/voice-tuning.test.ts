import { describe, expect, it } from 'vitest';
import type { NetPort } from '@winsendotai/ovo-contracts';
import { openAiInference } from '../src/inference.ts';
import { lowestReasoningEffort, resolveVoiceTuning } from '../src/voice-tuning.ts';
import { openAiInferencePlugin } from '../src/index.ts';

// LAT-7: the request only sent model, temperature and max tokens, so gpt-6-luna ran at its default
// (medium) reasoning effort and the first sentence took 1.3-3.0s.
function capturingNet() {
  const bodies: Record<string, unknown>[] = [];
  const net: NetPort = {
    async fetch(_url, init) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'resp-1',
          created_at: 0,
          model: 'fixture',
          output: [
            {
              type: 'message',
              role: 'assistant',
              id: 'msg-1',
              content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    websocket() {
      throw new Error('not used');
    },
  };
  return { net, bodies };
}

const request = () => ({
  input: 'hi',
  context: '',
  uncertainty: 'I am not sure.',
  tools: [],
  results: [],
  signal: new AbortController().signal,
});

async function wireBody(
  binding: Parameters<typeof openAiInference>[2],
  settings: Parameters<typeof openAiInference>[5] = {},
) {
  const { net, bodies } = capturingNet();
  await openAiInference(net, 'fixture-key', binding, undefined, undefined, settings).generate(
    request(),
  );
  return bodies[0]!;
}

describe('voice request tuning (LAT-7)', () => {
  it('sends gpt-6-luna its lowest effort, no stored response and a per-binding cache key', async () => {
    const body = await wireBody({ model: 'gpt-6-luna' }, { bindingId: 'binding-1' });
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      reasoning: { effort: 'none' },
      store: false,
      prompt_cache_key: 'ovo:binding-1',
    });
    // Not documented for gpt-6, so not sent unless an operator opts in.
    expect(body.text).toBeUndefined();
    expect(body.service_tier).toBeUndefined();
  });

  it('gives gpt-5 minimal effort and low verbosity, and other gpt-6 models low effort', async () => {
    expect(await wireBody({ model: 'gpt-5' })).toMatchObject({
      reasoning: { effort: 'minimal' },
      text: { verbosity: 'low' },
    });
    expect(await wireBody({ model: 'gpt-6-astra' })).toMatchObject({
      reasoning: { effort: 'low' },
    });
  });

  it('sends no reasoning settings to a non-reasoning model', async () => {
    const body = await wireBody({ model: 'gpt-4o-mini' });
    expect(body.reasoning).toBeUndefined();
    expect(body.text).toBeUndefined();
    expect(body.store).toBe(false);
  });

  it('prefers binding fields, then OVO_LLM_* env overrides, then defaults', async () => {
    const env = {
      OVO_LLM_REASONING_EFFORT: 'low',
      OVO_LLM_TEXT_VERBOSITY: 'low',
      OVO_LLM_SERVICE_TIER: 'priority',
      OVO_LLM_STORE: 'true',
    };
    expect(await wireBody({ model: 'gpt-6-luna' }, { env })).toMatchObject({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      service_tier: 'priority',
      store: true,
    });
    expect(
      await wireBody(
        { model: 'gpt-6-luna', reasoningEffort: 'medium', store: false, promptCacheKey: 'jev' },
        { env, bindingId: 'binding-1' },
      ),
    ).toMatchObject({ reasoning: { effort: 'medium' }, store: false, prompt_cache_key: 'jev' });
  });

  it('lets an operator fall back to the model default with `unset`', () => {
    expect(
      resolveVoiceTuning('gpt-6-luna', {}, { OVO_LLM_REASONING_EFFORT: 'unset' }),
    ).not.toHaveProperty('reasoningEffort');
  });

  it('rejects a misspelt override instead of silently sending the model default', () => {
    expect(() =>
      resolveVoiceTuning('gpt-6-luna', {}, { OVO_LLM_REASONING_EFFORT: 'minimum' }),
    ).toThrow(/OVO_LLM_REASONING_EFFORT/);
    expect(() => resolveVoiceTuning('gpt-6-luna', {}, { OVO_LLM_STORE: 'yes' })).toThrow(
      /OVO_LLM_STORE/,
    );
  });

  it('maps model families to the lowest effort they accept', () => {
    expect(lowestReasoningEffort('gpt-6-sol')).toBe('none');
    expect(lowestReasoningEffort('gpt-5.4-mini')).toBe('none');
    expect(lowestReasoningEffort('gpt-5-chat-latest')).toBeUndefined();
    expect(lowestReasoningEffort('o4-mini')).toBe('low');
    expect(lowestReasoningEffort('gpt-4.1')).toBeUndefined();
  });

  it('declares the tuning fields on the binding schema', () => {
    const properties = (
      openAiInferencePlugin.manifest as { bindingSchema?: { properties?: object } }
    ).bindingSchema?.properties;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining([
        'reasoningEffort',
        'textVerbosity',
        'serviceTier',
        'promptCacheKey',
        'store',
      ]),
    );
  });
});
