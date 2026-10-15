import type { Inference, InferenceReply, InferenceRequest } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { createLlmRunner, routeTool } from '../src/engines/index.ts';
import { engineInput, engineNode, engineOf, forever, untilAborted } from './support.ts';

const llmNode = (over: Record<string, unknown> = {}) =>
  engineNode([{ kind: 'llm', instructions: 'Route the caller.', timeoutMs: 300, ...over }]);
const turn = { text: 'mujhe naya card chahiye' };

/** A scripted Inference: answers with `reply`, recording every request. */
function inference(reply: (request: InferenceRequest) => Promise<InferenceReply>) {
  const requests: InferenceRequest[] = [];
  const port: Inference = {
    model: 'router-model-1',
    generate: (request) => {
      requests.push(request);
      return reply(request);
    },
  };
  return { port, requests };
}

const tool = (input: unknown): InferenceReply => ({ kind: 'tool', toolId: 'ovo_route', input });

async function classify(reply: InferenceReply, over: Record<string, unknown> = {}) {
  const node = llmNode(over);
  const { port, requests } = inference(async () => reply);
  const result = await createLlmRunner(port)(engineOf(node, 'llm'), engineInput(node, turn));
  return { result, requests };
}

describe('llm engine: the ovo_route tool', () => {
  it('offers one tool whose enums are the branches (plus null) and, when asked, the languages', () => {
    const node = llmNode({ detectLanguage: true, generatedClarify: true });
    const offered = routeTool(
      engineOf(node, 'llm'),
      engineInput(node, turn, { languages: ['en', 'hi', 'ta'] }),
    );
    expect(offered).toMatchObject({ id: 'ovo_route', connector: 'native', effect: 'read' });
    expect(offered.inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['branch', 'confidence'],
      properties: {
        branch: { enum: ['sales', 'support', null] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        language: { enum: ['en', 'hi', 'ta'] },
        clarify: { type: 'string', maxLength: 200 },
      },
    });
    const plain = llmNode();
    const bare = routeTool(engineOf(plain, 'llm'), engineInput(plain, turn)).inputSchema;
    expect(Object.keys(bare.properties as object)).toEqual(['branch', 'confidence']);
  });

  it('sends the turn as input, the transcript as history, the branches in context, no provider tools', async () => {
    const node = llmNode();
    const { port, requests } = inference(async () => tool({ branch: 'sales', confidence: 0.9 }));
    const transcript = [
      { role: 'router' as const, text: 'Welcome.' },
      { role: 'caller' as const, text: 'hello' },
    ];
    await createLlmRunner(port)(engineOf(node, 'llm'), engineInput(node, turn, { transcript }));
    const [request] = requests;
    expect(request!.input).toBe('mujhe naya card chahiye');
    expect(request!.history).toEqual([
      { role: 'assistant', content: 'Welcome.' },
      { role: 'user', content: 'hello' },
    ]);
    expect(request!.context).toContain('- sales: The caller wants sales');
    expect(request!.context).toContain('Route the caller.');
    expect(request!.tools.map((offered) => offered.id)).toEqual(['ovo_route']);
    expect(request!.providerTools).toBe(false);
  });
});

describe('llm engine: verdicts', () => {
  it.each<[string, InferenceReply, Record<string, unknown>, Record<string, unknown>]>([
    [
      'a confident branch matches',
      tool({ branch: 'sales', confidence: 0.91 }),
      {},
      { outcome: 'matched', branch: 'sales', confidence: 0.91 },
    ],
    [
      'the threshold itself matches',
      tool({ branch: 'sales', confidence: 0.6 }),
      {},
      { outcome: 'matched' },
    ],
    [
      'under the threshold is low confidence',
      tool({ branch: 'sales', confidence: 0.4 }),
      {},
      { outcome: 'low_confidence', branch: 'sales', confidence: 0.4 },
    ],
    [
      'a null branch is low confidence',
      tool({ branch: null, confidence: 0.9 }),
      {},
      { outcome: 'low_confidence', confidence: 0.9 },
    ],
    [
      'a text reply is no match',
      { kind: 'text', text: 'Sure! Sales it is.' },
      {},
      { outcome: 'no_match', reason: 'llm_text_reply' },
    ],
    [
      'a branch outside the enum is an error',
      tool({ branch: 'billing', confidence: 0.9 }),
      {},
      { outcome: 'error', reason: 'invalid_tool_input' },
    ],
    [
      'a confidence outside 0-1 is an error',
      tool({ branch: 'sales', confidence: 1.5 }),
      {},
      { outcome: 'error', reason: 'invalid_tool_input' },
    ],
    [
      'a missing confidence is an error',
      tool({ branch: 'sales' }),
      {},
      { outcome: 'error', reason: 'invalid_tool_input' },
    ],
    [
      'another tool is an error',
      { kind: 'tool', toolId: 'end_call', input: {} },
      {},
      { outcome: 'error', reason: 'unknown_tool' },
    ],
    [
      'a detected language is kept',
      tool({ branch: 'sales', confidence: 0.9, language: 'hi' }),
      { detectLanguage: true },
      { outcome: 'matched', language: 'hi' },
    ],
    [
      'a language outside the enum is an error',
      tool({ branch: 'sales', confidence: 0.9, language: 'fr' }),
      { detectLanguage: true },
      { outcome: 'error', reason: 'invalid_tool_input' },
    ],
  ])('%s', async (_name, reply, over, expected) => {
    const { result } = await classify(reply, over);
    expect(result).toMatchObject({ ...expected, modelId: 'router-model-1' });
  });

  it('ignores a language it did not ask for', async () => {
    const { result } = await classify(tool({ branch: 'sales', confidence: 0.9, language: 'fr' }));
    expect(result).toEqual({
      outcome: 'matched',
      branch: 'sales',
      confidence: 0.9,
      modelId: 'router-model-1',
    });
  });
});

describe('llm engine: the generated clarify gate', () => {
  const unsure = tool({
    branch: null,
    confidence: 0.3,
    clarify: '  Is this about a new card or an existing one?  ',
  });

  it('keeps the clarifying question only with generatedClarify, trimmed', async () => {
    expect((await classify(unsure, { generatedClarify: true })).result.clarify).toBe(
      'Is this about a new card or an existing one?',
    );
    expect((await classify(unsure)).result.clarify).toBeUndefined();
  });

  it('never carries a question on a confident verdict, and caps it at 200 characters', async () => {
    const confident = tool({ branch: 'sales', confidence: 0.9, clarify: 'Why?' });
    expect((await classify(confident, { generatedClarify: true })).result.clarify).toBeUndefined();
    const long = tool({ branch: null, confidence: 0.1, clarify: 'x'.repeat(500) });
    expect((await classify(long, { generatedClarify: true })).result.clarify).toHaveLength(200);
  });
});

describe('llm engine: failures', () => {
  it('times out at its deadline, whether or not the port honours the signal', async () => {
    const node = llmNode();
    for (const reply of [
      (r: InferenceRequest) => untilAborted<InferenceReply>(r.signal),
      () => forever<InferenceReply>(),
    ]) {
      const { port } = inference(reply);
      await expect(
        createLlmRunner(port)(engineOf(node, 'llm'), engineInput(node, turn)),
      ).resolves.toEqual({
        outcome: 'timeout',
        modelId: 'router-model-1',
      });
    }
  });

  it('reports a provider failure as an error, and no LLM as disabled', async () => {
    const node = llmNode();
    const { port } = inference(async () => {
      throw new Error('429');
    });
    await expect(
      createLlmRunner(port)(engineOf(node, 'llm'), engineInput(node, turn)),
    ).resolves.toMatchObject({
      outcome: 'error',
      reason: 'llm_failed',
    });
    await expect(
      createLlmRunner(undefined)(engineOf(node, 'llm'), engineInput(node, turn)),
    ).resolves.toEqual({
      outcome: 'disabled',
      reason: 'llm_unavailable',
    });
  });

  it('does not call the model for an empty turn', async () => {
    const { result, requests } = await classify(tool({ branch: 'sales', confidence: 1 }));
    expect(result.outcome).toBe('matched');
    const node = llmNode();
    const empty = inference(async () => tool({ branch: 'sales', confidence: 1 }));
    await expect(
      createLlmRunner(empty.port)(engineOf(node, 'llm'), engineInput(node, { text: '' })),
    ).resolves.toEqual({
      outcome: 'no_match',
      reason: 'empty_turn',
    });
    expect(empty.requests).toHaveLength(0);
    expect(requests).toHaveLength(1);
  });
});
