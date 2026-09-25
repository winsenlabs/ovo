import { AgentConfig, Cap, type UsageMeter } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { InstalledProviderEvaluationInferenceFactory } from '../src/provider-evaluation-inference.ts';

const llm = definePlugin(
  {
    id: 'fixture-alternate-llm',
    version: '1.2.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'llm',
    provider: 'alternate',
    provides: [Cap.inference],
    requires: [Cap.usage],
    configSchema: { type: 'object' },
    secretFields: [],
    capabilities: { tools: false, streaming: false },
    meters: [
      {
        key: 'alternate.inference.input_tokens',
        unit: 'input_tokens',
        label: 'Input',
        role: 'llm',
      },
    ],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['llm@1'],
  },
  (ctx) => {
    const usage = ctx.get(Cap.usage) as (meter: UsageMeter) => void;
    ctx.provide(Cap.inference, {
      generate: async () => {
        usage({
          provider: 'alternate',
          operation: 'inference',
          unit: 'input_tokens',
          quantity: '3',
          state: 'reconciled',
          requestId: 'alternate-request-1',
          elapsedMs: 0,
        });
        return { kind: 'text', text: 'Selected alternate reply' };
      },
    });
  },
);

const release = {
  id: 'release-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  fingerprint: 'fingerprint-1',
  config: AgentConfig.parse({ name: 'Alternate', mode: 'announcement', message: 'Hello' }),
  providerBindings: {
    inference: {
      id: 'binding-1',
      workspaceId: 'workspace-1',
      provider: 'alternate',
      credentialId: 'credential-1',
      config: { model: 'alternate-model' },
      updatedAt: 'revision-1',
      pluginId: llm.manifest.id,
      pluginVersion: '1.0.0',
    },
  },
} as never;

describe('installed provider evaluation inference', () => {
  it('runs a release-pinned non-OpenAI llm and reports its native meter', async () => {
    const onUsage = vi.fn(async () => undefined);
    const factory = new InstalledProviderEvaluationInferenceFactory([llm], {
      forAgent: () => ({ resolve: async () => 'not-used' }),
    } as never);
    const inference = await factory.create({
      release,
      bindingVersion: 'binding-1:revision-1',
      provider: 'alternate',
      modelId: 'alternate-model',
      maxOutputTokens: 10,
      signal: new AbortController().signal,
      onUsage,
    });
    expect(inference.provider).toBe('alternate');
    expect(await inference.generate({} as never)).toEqual({
      kind: 'text',
      text: 'Selected alternate reply',
    });
    expect(onUsage).toHaveBeenCalledWith({
      requestId: 'alternate-request-1',
      modelId: 'alternate-model',
      usage: { inputTokens: 3 },
    });
  });
});
