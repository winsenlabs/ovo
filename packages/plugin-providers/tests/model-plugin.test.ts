import { describe, expect, it } from 'vitest';
import type { SecretResolver } from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import {
  OPENAI_INFERENCE_PLUGIN_CONFIG_SCHEMA,
  PROVIDER_PLUGIN_IDS,
  PROVIDER_SERVICE_KEYS,
  createOpenAiBatchSttPlugin,
  createOpenAiInferenceProviderPlugin,
  createOpenAiModelFactory,
  openAiInferenceBindingFromRecord,
  validateProviderEndpoint,
  type OpenAiBatchSttBinding,
  type OpenAiInferenceBinding,
} from '../src/index.ts';

const inferenceBinding = (): OpenAiInferenceBinding => ({
  workspaceId: 'single-tenant',
  bindingVersion: 'binding-1:2026-09-20T00:00:00Z',
  credentialId: 'credential-1',
  model: 'gpt-5-mini',
  api: 'responses',
});

describe('OpenAI inference provider binding', () => {
  it('takes an immutable snapshot before resolving the server-side credential', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = inferenceBinding();
    const secrets: SecretResolver = {
      async resolve(workspaceId, credentialId) {
        expect([workspaceId, credentialId]).toEqual(['single-tenant', 'credential-1']);
        await waiting;
        return 'openai-test-key';
      },
    };
    const pending = createOpenAiModelFactory(source, secrets);
    source.model = 'mutated-model';
    source.credentialId = 'mutated-credential';
    release();
    const factory = await pending;
    expect(factory.binding).toMatchObject({ model: 'gpt-5-mini', credentialId: 'credential-1' });
    expect(Object.isFrozen(factory.binding)).toBe(true);
    expect((factory.model() as unknown as { modelId: string }).modelId).toBe('gpt-5-mini');
  });

  it('exports a composable manifest that resolves credentials only inside the plugin', async () => {
    let resolutions = 0;
    const secretPlugin = definePlugin(
      {
        id: 'test.secret-resolver',
        version: '0.1.0',
        contractVersion: 1,
        scope: 'process',
        requires: [],
        provides: [PROVIDER_SERVICE_KEYS.secretResolver],
        configSchema: { type: 'object', additionalProperties: false },
        secretFields: [],
      },
      (ctx) => {
        ctx.provide(PROVIDER_SERVICE_KEYS.secretResolver, {
          async resolve() {
            resolutions += 1;
            return 'openai-test-key';
          },
        } satisfies SecretResolver);
      },
    );
    const provider = createOpenAiInferenceProviderPlugin(inferenceBinding());
    expect(provider.manifest).toMatchObject({
      id: PROVIDER_PLUGIN_IDS.openAiInference,
      requires: [PROVIDER_SERVICE_KEYS.secretResolver],
      provides: [PROVIDER_SERVICE_KEYS.inference],
      configSchema: OPENAI_INFERENCE_PLUGIN_CONFIG_SCHEMA,
    });
    const composition = await compose(
      [
        { id: secretPlugin.manifest.id },
        { id: provider.manifest.id, config: { instructions: 'Be concise.', maxOutputTokens: 80 } },
      ],
      [secretPlugin, provider],
    );
    expect(composition.ctx.get(PROVIDER_SERVICE_KEYS.inference)).toBeDefined();
    expect(resolutions).toBe(1);
    await composition.dispose();
  });

  it('parses strict stored bindings and keeps batch transcription a distinct capability', () => {
    expect(
      openAiInferenceBindingFromRecord({
        id: 'binding-1',
        workspaceId: 'single-tenant',
        provider: 'openai',
        credentialId: 'credential-1',
        config: { model: 'gpt-5-mini', api: 'chat' },
        updatedAt: '2026-09-20T00:00:00Z',
      }),
    ).toEqual({
      workspaceId: 'single-tenant',
      credentialId: 'credential-1',
      bindingVersion: 'binding-1:2026-09-20T00:00:00Z',
      model: 'gpt-5-mini',
      api: 'chat',
    });
    expect(() =>
      openAiInferenceBindingFromRecord({
        id: 'binding-1',
        workspaceId: 'single-tenant',
        provider: 'openai',
        credentialId: 'credential-1',
        config: { model: 'gpt-5-mini', apiKey: 'forbidden' },
        updatedAt: 'v1',
      }),
    ).toThrow('Unknown provider binding fields');
    const batch = createOpenAiBatchSttPlugin({
      ...inferenceBinding(),
      language: 'en',
      requestTimeoutMs: 1_000,
      maxAudioBytes: 1_024,
      maxResponseBytes: 1_024,
    } satisfies OpenAiBatchSttBinding);
    expect(batch.manifest.provides).toEqual([PROVIDER_SERVICE_KEYS.batchStt]);
    expect(batch.manifest.provides).not.toContain(PROVIDER_SERVICE_KEYS.streamingStt);
  });

  it('rejects non-HTTPS and private production HTTP endpoints', () => {
    expect(() =>
      validateProviderEndpoint('http://api.openai.com/v1/audio/speech', '/v1/audio/speech'),
    ).toThrow('HTTPS');
    expect(() =>
      validateProviderEndpoint('https://127.0.0.1/v1/audio/speech', '/v1/audio/speech'),
    ).toThrow('Private');
    expect(() =>
      validateProviderEndpoint('https://example.com/v1/audio/speech', '/v1/audio/speech'),
    ).toThrow('api.openai.com');
  });
});
