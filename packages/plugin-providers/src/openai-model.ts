import { createOpenAI } from '@ai-sdk/openai';
import type { SecretResolver } from '@winsendotai/ovo-contracts';
import type { AiSdkInferencePluginConfig } from '@winsendotai/ovo-plugin-inference';
import { immutableBinding, type OpenAiInferenceBinding } from './types.ts';

type OpenAiLanguageModel = ReturnType<ReturnType<typeof createOpenAI>['responses']>;

export class OpenAiModelFactory {
  readonly binding: Readonly<OpenAiInferenceBinding>;

  private constructor(
    binding: OpenAiInferenceBinding,
    private readonly apiKey: string,
  ) {
    this.binding = immutableBinding(binding);
  }

  static async create(
    binding: OpenAiInferenceBinding,
    secrets: SecretResolver,
  ): Promise<OpenAiModelFactory> {
    const snapshot = immutableBinding(binding);
    if (snapshot.api !== 'responses' && snapshot.api !== 'chat')
      throw new TypeError('OpenAI inference api must be responses or chat');
    const apiKey = await secrets.resolve(snapshot.workspaceId, snapshot.credentialId);
    return new OpenAiModelFactory(snapshot, apiKey);
  }

  model(): OpenAiLanguageModel {
    const provider = createOpenAI({ apiKey: this.apiKey });
    return this.binding.api === 'responses'
      ? provider.responses(this.binding.model)
      : provider.chat(this.binding.model);
  }

  resolve = (config: AiSdkInferencePluginConfig): OpenAiLanguageModel => {
    if (config.model !== this.binding.model)
      throw new TypeError('Inference request model does not match the immutable provider binding');
    if (config.credentialId && config.credentialId !== this.binding.credentialId)
      throw new TypeError('Inference credential does not match the immutable provider binding');
    return this.model();
  };
}

export function createOpenAiModelFactory(
  binding: OpenAiInferenceBinding,
  secrets: SecretResolver,
): Promise<OpenAiModelFactory> {
  return OpenAiModelFactory.create(binding, secrets);
}
