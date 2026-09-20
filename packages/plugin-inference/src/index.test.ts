import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { InferenceRequest } from '@winsendotai/ovo-contracts';
import { AiSdkInference, SimulatedInference } from './index.ts';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

function request(signal = new AbortController().signal): InferenceRequest {
  return {
    input: 'Check the balance',
    context: 'Use approved records only.',
    uncertainty: 'I do not know.',
    tools: [
      {
        id: 'balance',
        description: 'Read balance',
        connector: 'native',
        inputSchema: {
          type: 'object',
          required: ['account'],
          properties: { account: { type: 'string' } },
        },
        effect: 'read',
        confirmation: false,
        timeoutMs: 1000,
      },
    ],
    results: [],
    signal,
  };
}

describe('AiSdkInference', () => {
  it('performs one SDK step and returns a tool request without executing it', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'balance',
            input: '{"account":"A-1"}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage,
        warnings: [],
      },
    });
    const inference = new AiSdkInference({ model });

    await expect(inference.generate(request())).resolves.toEqual({
      kind: 'tool',
      toolId: 'balance',
      input: { account: 'A-1' },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});

describe('SimulatedInference', () => {
  it('is explicitly scripted and obeys abort', async () => {
    const simulated = new SimulatedInference({ replies: [{ kind: 'text', text: 'fixture' }] });
    await expect(simulated.generate(request())).resolves.toEqual({ kind: 'text', text: 'fixture' });

    const controller = new AbortController();
    const delayed = new SimulatedInference({ delayMs: 100 });
    const pending = delayed.generate(request(controller.signal));
    controller.abort(new DOMException('takeover', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
