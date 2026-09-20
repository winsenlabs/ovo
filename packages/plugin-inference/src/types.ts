import type { LanguageModel } from 'ai';
import type { InferenceReply, InferenceRequest } from '@winsendotai/ovo-contracts';

export const INFERENCE_SERVICE_KEY = 'ovo.inference';
export const INFERENCE_PLUGIN_IDS = Object.freeze({
  aiSdk: '@winsendotai/ovo-plugin-inference-ai-sdk',
  simulated: '@winsendotai/ovo-plugin-inference-simulated',
});

export interface AiSdkInferenceOptions {
  model: LanguageModel;
  instructions?: string;
  maxOutputTokens?: number;
  onUsage?: (evidence: { requestId?: string; modelId?: string; usage: Record<string, number> }) => void | Promise<void>;
}

export interface AiSdkInferencePluginConfig {
  model: string;
  credentialId?: string;
  instructions?: string;
  maxOutputTokens?: number;
}

export interface AiSdkInferencePluginOptions {
  resolveModel(config: AiSdkInferencePluginConfig): LanguageModel | Promise<LanguageModel>;
  id?: string;
}

export type SimulatedReplyFactory = (
  request: InferenceRequest,
  callIndex: number,
) => InferenceReply | Promise<InferenceReply>;

export interface SimulatedInferenceOptions {
  replies?: readonly InferenceReply[];
  responder?: SimulatedReplyFactory;
  delayMs?: number;
}
