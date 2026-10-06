import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { InferenceRequest, ToolDefinition } from '@winsendotai/ovo-contracts';
import { AiSdkInference } from '../src/ai-sdk-inference.ts';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const resumeFlow: ToolDefinition = {
  id: 'resume_flow',
  description: 'Hand the call back to the scripted conversation.',
  connector: 'native',
  inputSchema: { type: 'object' },
  effect: 'read',
  confirmation: false,
  timeoutMs: 1_000,
};

function request(): InferenceRequest {
  return {
    input: 'is this about my loan?',
    context: '',
    uncertainty: 'I am not sure.',
    tools: [resumeFlow],
    results: [],
    signal: new AbortController().signal,
  };
}

function model(parts: unknown[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          for (const part of parts) controller.enqueue(part as never);
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
}

const text = [
  { type: 'text-start', id: 't-1' },
  { type: 'text-delta', id: 't-1', delta: 'Yes, it is about your loan. ' },
  { type: 'text-end', id: 't-1' },
];
const call = {
  type: 'tool-call',
  toolCallId: 'c-1',
  toolName: 'resume_flow',
  input: '{"resume_at":"identity","action":"none"}',
};

describe('a streamed step with text and a tool call (AGT-7)', () => {
  it('streams the answer, then the tool the model called after it', async () => {
    const events = [];
    for await (const event of new AiSdkInference({ model: model([...text, call]) }).stream(
      request(),
    ))
      events.push(event);
    expect(events.map((event) => event.kind)).toEqual(['text-delta', 'tool', 'finish']);
    expect(events[1]).toEqual({
      kind: 'tool',
      toolId: 'resume_flow',
      input: { resume_at: 'identity', action: 'none' },
    });
  });

  it('still refuses text after a tool call', async () => {
    const consume = async () => {
      for await (const _ of new AiSdkInference({ model: model([call, ...text]) }).stream(request()))
        void _;
    };
    await expect(consume()).rejects.toThrow('Inference mixed a tool call with response text');
  });
});
