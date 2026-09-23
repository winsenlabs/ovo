import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { meterKey, type InferenceRequest, type UsageMeter } from '@winsendotai/ovo-contracts';
import * as toolsErrors from '../../plugin-tools/src/errors.ts';
import * as inferenceAiSdk from '../../plugin-inference/src/ai-sdk.ts';
import {
  AiSdkInference,
  ConfirmationRequiredError,
  ConnectorPolicyError,
  ExecutionPolicyError,
  InferenceProtocolError,
  OperationCollisionError,
  ToolInvocationError,
  ToolSchemaError,
} from '../src/index.ts';

const request = (): InferenceRequest => ({
  input: 'hello',
  context: '',
  uncertainty: 'I do not know.',
  tools: [],
  results: [],
  signal: new AbortController().signal,
});

const generated = (id?: string) =>
  new MockLanguageModelV4({
    provider: 'openai.responses',
    modelId: 'gpt-4o-mini',
    doGenerate: {
      content: [{ type: 'text', text: 'hi' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: undefined },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      },
      warnings: [],
      ...(id ? { response: { id } } : {}),
    },
  });

describe('tool errors moved to plugin-kit (#12)', () => {
  it('keeps the hierarchy and adds ConnectorPolicyError under ExecutionPolicyError', () => {
    const policy = new ConnectorPolicyError('private DNS');
    expect(policy).toBeInstanceOf(ExecutionPolicyError);
    expect(new ConfirmationRequiredError('x')).toBeInstanceOf(ExecutionPolicyError);
    expect(new OperationCollisionError('x')).toBeInstanceOf(ExecutionPolicyError);
    expect(
      new ToolSchemaError('bad', [
        { instancePath: '/a', schemaPath: '#', keyword: 'type', params: {} },
      ]).errors,
    ).toHaveLength(1);
    expect(new ToolInvocationError('x', 'unknown').outcome).toBe('unknown');
  });

  it('is re-exported, identically, from plugin-tools', () => {
    expect(toolsErrors.ExecutionPolicyError).toBe(ExecutionPolicyError);
    expect(toolsErrors.ConnectorPolicyError).toBe(ConnectorPolicyError);
    expect(toolsErrors.ToolInvocationError).toBe(ToolInvocationError);
  });
});

describe('AiSdkInference moved to plugin-kit', () => {
  it('is re-exported, identically, from plugin-inference', () => {
    expect(inferenceAiSdk.AiSdkInference).toBe(AiSdkInference);
    expect(inferenceAiSdk.InferenceProtocolError).toBe(InferenceProtocolError);
  });

  it('exposes provider and model and reports reconciled token meters to the UsageSink', async () => {
    const meters: UsageMeter[] = [];
    const inference = new AiSdkInference({
      model: generated('resp-1'),
      usage: (m) => meters.push(m),
      now: () => 0,
    });
    expect(inference.provider).toBe('openai');
    expect(inference.model).toBe('gpt-4o-mini');
    await inference.generate(request());
    expect(meters.map((m) => meterKey(m))).toEqual([
      'openai.inference.input_tokens',
      'openai.inference.uncached_input_tokens',
      'openai.inference.cache_read_input_tokens',
      'openai.inference.output_tokens',
    ]);
    expect(meters.every((m) => m.requestId === 'resp-1' && m.state === 'reconciled')).toBe(true);
    expect(meters[0]!.quantity).toBe('10');
  });

  it('synthesizes a requestId when the provider returns none, and honours a provider override', async () => {
    const meters: UsageMeter[] = [];
    const model = generated();
    const inference = new AiSdkInference({
      model,
      provider: 'azure',
      sessionId: 'call-9',
      usage: (m) => meters.push(m),
    });
    await inference.generate(request());
    expect(inference.provider).toBe('azure');
    expect(meters.every((m) => m.requestId.length > 0 && m.provider === 'azure')).toBe(true);
  });
});
