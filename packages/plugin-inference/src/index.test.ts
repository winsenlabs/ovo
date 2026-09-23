import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { InferenceRequest } from '@winsendotai/ovo-contracts';
import { AiSdkInference, SimulatedInference, type AiSdkInferenceOptions } from './index.ts';

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
  it('does not expose provider SDK error objects or credential fragments', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('Incorrect API key: fixture-private-token');
      },
    });
    const inference = new AiSdkInference({ model });
    await expect(inference.generate(request())).rejects.toThrow(
      'Inference provider request failed',
    );
  });
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
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        uncachedInputTokens: 10,
        textOutputTokens: 2,
      },
    });
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('retains provider cache read/write evidence without caching model answers', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'fixture answer' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 100, noCache: 30, cacheRead: 50, cacheWrite: 20 },
          outputTokens: { total: 12, text: 10, reasoning: 2 },
        },
        warnings: [],
      },
    });
    const inference = new AiSdkInference({ model });
    const first = await inference.generate(request());
    await inference.generate(request());
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(first.usage).toEqual({
      inputTokens: 100,
      outputTokens: 12,
      totalTokens: 112,
      uncachedInputTokens: 30,
      cacheReadInputTokens: 50,
      cacheWriteInputTokens: 20,
      textOutputTokens: 10,
      reasoningOutputTokens: 2,
    });
  });

  it('streams text deltas before completion and reports compact usage exactly once', async () => {
    let streamController!: ReadableStreamDefaultController<any>;
    let ready!: () => void;
    const controllerReady = new Promise<void>((resolve) => (ready = resolve));
    const onUsage: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            streamController = controller;
            ready();
          },
        }),
        response: { headers: { 'x-request-id': 'request-1' } },
      }),
    });
    const inference = new AiSdkInference({
      model,
      onUsage: (evidence) => {
        onUsage.push(evidence);
      },
    });
    const iterator = inference.stream(request())[Symbol.asyncIterator]();
    const first = iterator.next();
    await controllerReady;
    streamController.enqueue({ type: 'stream-start', warnings: [] });
    streamController.enqueue({ type: 'response-metadata', id: 'response-1', modelId: 'model-1' });
    streamController.enqueue({ type: 'text-start', id: 'text-1' });
    streamController.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Early sentence. ' });
    await expect(first).resolves.toEqual({
      done: false,
      value: { kind: 'text-delta', delta: 'Early sentence. ' },
    });
    expect(onUsage).toEqual([]);

    streamController.enqueue({ type: 'text-end', id: 'text-1' });
    streamController.enqueue({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
    });
    streamController.close();
    const remaining = [];
    for (;;) {
      const event = await iterator.next();
      if (event.done) break;
      remaining.push(event.value);
    }
    expect(remaining).toEqual([
      {
        kind: 'finish',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          uncachedInputTokens: 10,
          textOutputTokens: 2,
        },
      },
    ]);
    expect(onUsage).toEqual([
      expect.objectContaining({ requestId: 'request-1', modelId: 'model-1' }),
    ]);
  });

  it('streams a declared tool selection without executing it', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'balance',
              input: '{"account":"A-1"}',
            });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage,
            });
            controller.close();
          },
        }),
      }),
    });
    const events = [];
    for await (const event of new AiSdkInference({ model }).stream(request())) events.push(event);
    expect(events).toEqual([
      { kind: 'tool', toolId: 'balance', input: { account: 'A-1' } },
      {
        kind: 'finish',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          uncachedInputTokens: 10,
          textOutputTokens: 2,
        },
      },
    ]);
  });

  it('redacts streamed provider errors', async () => {
    const logging = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'error', error: new Error('private-token') });
            controller.close();
          },
        }),
      }),
    });
    const inference = new AiSdkInference({ model });
    const consume = async () => {
      for await (const _event of inference.stream(request())) void _event;
    };
    try {
      await expect(consume()).rejects.toMatchObject({
        message: 'Inference provider request failed',
      });
    } finally {
      logging.mockRestore();
    }
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

/**
 * `AiSdkInference` moved to plugin-kit and this package re-exports it. The assertion lives here,
 * in the package that does the re-export: a kit may not import a plugin, even from a test.
 */
describe('plugin-inference re-exports the kit inference classes identically', () => {
  it('exports the kit class itself, not a second copy', async () => {
    const kit = await import('@winsendotai/ovo-plugin-kit');
    const moved = await import('./ai-sdk.ts');
    expect(moved.AiSdkInference).toBe(kit.AiSdkInference);
    expect(moved.InferenceProtocolError).toBe(kit.InferenceProtocolError);
    expect(AiSdkInference).toBe(kit.AiSdkInference);
  });

  it('carries the kit option type, so provider, usage, sessionId and now are all available', () => {
    const options: AiSdkInferenceOptions = {
      model: new MockLanguageModelV4({ provider: 'openai.responses', modelId: 'gpt-4o-mini' }),
      provider: 'azure',
      usage: () => undefined,
      sessionId: 'call-1',
      now: () => 0,
    };
    expect(new AiSdkInference(options).provider).toBe('azure');
  });
});
