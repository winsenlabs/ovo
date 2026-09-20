import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  type Execution,
  type Inference,
  type InferenceRequest,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior, ContextBehavior, StreamingTextSegmenter } from '../src/index.ts';

function played(text: string, epoch: number, state: SpeechReceipt['state'] = 'completed') {
  return { id: `${epoch}-${text}`, text, epoch, state, evidence: 'confirmed' as const };
}

describe('streaming behaviors', () => {
  it('segments complete sentences and bounded Unicode text deterministically', () => {
    const sentences = new StreamingTextSegmenter(32, 64);
    expect(sentences.push('Ready now. More')).toEqual(['Ready now.']);
    expect(sentences.finish()).toEqual(['More']);
    const unicode = new StreamingTextSegmenter(32, 64);
    expect(unicode.push('😀'.repeat(20))).toEqual(['😀'.repeat(16)]);
    expect(unicode.finish()).toEqual(['😀'.repeat(4)]);
  });

  it('emits a sentence before inference finishes and remembers only playback evidence', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const requests: InferenceRequest[] = [];
    const inference: Inference = {
      generate: async () => ({ kind: 'text', text: 'fallback' }),
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { kind: 'text-delta', delta: 'First sentence. ' };
          await gate;
          yield { kind: 'text-delta', delta: 'Second sentence.' };
        } else {
          yield { kind: 'text-delta', delta: 'Next response.' };
        }
        yield { kind: 'finish' };
      },
    };
    const behavior = new ContextBehavior(
      AgentConfig.parse({ name: 'Context', mode: 'context', context: 'Known facts.' }),
      inference,
    );
    behavior.beginTurn(1);
    const iterator = behavior.respondStream('first')[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'First sentence.' });
    behavior.onPlayback(played('First sentence.', 1));
    release();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'Second sentence.' });
    behavior.onPlayback(played('Second sentence.', 1, 'interrupted'));
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    behavior.beginTurn(2);
    const next = behavior.respondStream('next')[Symbol.asyncIterator]();
    await next.next();
    expect(requests[1]?.history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'First sentence.' },
      {
        role: 'assistant',
        content: '[The response was interrupted. Do not assume any unconfirmed words were heard.]',
      },
    ]);
    behavior.cancel();
  });

  it('keeps tool execution in the shared boundary before streaming the final response', async () => {
    let inferenceCalls = 0;
    const inference: Inference = {
      generate: async () => ({ kind: 'text', text: 'fallback' }),
      async *stream() {
        inferenceCalls++;
        if (inferenceCalls === 1) {
          yield { kind: 'tool', toolId: 'balance', input: { account: 'A-1' } };
        } else {
          yield { kind: 'text-delta', delta: 'Your balance is 42.' };
        }
        yield { kind: 'finish' };
      },
    };
    const requests: Parameters<Execution['execute']>[0][] = [];
    const execution: Execution = {
      execute: async (request) => {
        requests.push(request);
        return { ...request, state: 'succeeded', result: { balance: 42 }, createdAt: 'now' };
      },
    };
    const behavior = new AgentBehavior(
      AgentConfig.parse({
        name: 'Agent',
        mode: 'agent',
        allowedTools: ['balance'],
        tools: [
          {
            id: 'balance',
            description: 'Read balance',
            connector: 'native',
            effect: 'read',
            inputSchema: {
              type: 'object',
              required: ['account'],
              properties: { account: { type: 'string' } },
            },
          },
        ],
      }),
      inference,
      execution,
      { workspaceId: 'local', sessionId: 'call', operationId: () => 'operation-1' },
    );
    behavior.beginTurn(1);
    const segments: string[] = [];
    for await (const segment of behavior.respondStream('balance')) segments.push(segment);

    expect(segments).toEqual(['Your balance is 42.']);
    expect(requests).toEqual([
      expect.objectContaining({ id: 'operation-1', toolId: 'balance', confirmed: false }),
    ]);
    expect(inferenceCalls).toBe(2);
  });

  it('refuses a tool side effect when a provider mixes it with streamed speech', async () => {
    const inference: Inference = {
      generate: async () => ({ kind: 'text', text: 'fallback' }),
      async *stream() {
        yield { kind: 'text-delta', delta: 'I will change that. ' };
        yield { kind: 'tool', toolId: 'change', input: {} };
        yield { kind: 'finish' };
      },
    };
    let executions = 0;
    const behavior = new AgentBehavior(
      AgentConfig.parse({
        name: 'Safe agent',
        mode: 'agent',
        allowedTools: ['change'],
        tools: [
          {
            id: 'change',
            description: 'Make a change',
            connector: 'native',
            effect: 'write',
            confirmation: true,
            inputSchema: { type: 'object' },
          },
        ],
      }),
      inference,
      {
        execute: async (request) => {
          executions++;
          return { ...request, state: 'succeeded', createdAt: 'now' };
        },
      },
      { workspaceId: 'local', sessionId: 'call' },
    );
    behavior.beginTurn(1);
    const consume = async () => {
      for await (const _segment of behavior.respondStream('change it')) void _segment;
    };

    await expect(consume()).rejects.toThrow('Tool call followed streamed response text');
    expect(executions).toBe(0);
  });
});
