import type { InferenceReply } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { AiSdkInference } from './ai-sdk.ts';
import { SimulatedInference } from './simulated.ts';
import {
  INFERENCE_PLUGIN_IDS,
  INFERENCE_SERVICE_KEY,
  type AiSdkInferencePluginConfig,
  type AiSdkInferencePluginOptions,
  type SimulatedInferenceOptions,
} from './types.ts';

export function createAiSdkInferencePlugin(options: AiSdkInferencePluginOptions) {
  return definePlugin(
    {
      id: options.id ?? INFERENCE_PLUGIN_IDS.aiSdk,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: [INFERENCE_SERVICE_KEY],
      configSchema: {
        type: 'object',
        required: ['model'],
        properties: {
          model: { type: 'string', minLength: 1 },
          credentialId: { type: 'string', minLength: 1 },
          instructions: { type: 'string', maxLength: 20_000 },
          maxOutputTokens: { type: 'integer', minimum: 1, maximum: 32_000 },
        },
        additionalProperties: false,
      },
      // credentialId is an opaque server-side reference, not a secret value.
      secretFields: [],
    },
    async (ctx, rawConfig) => {
      const config = parseAiSdkConfig(rawConfig);
      const model = await options.resolveModel(config);
      ctx.provide(
        INFERENCE_SERVICE_KEY,
        new AiSdkInference({
          model,
          instructions: config.instructions,
          maxOutputTokens: config.maxOutputTokens,
        }),
      );
    },
  );
}

export function createSimulatedInferencePlugin(defaults: SimulatedInferenceOptions = {}) {
  return definePlugin(
    {
      id: INFERENCE_PLUGIN_IDS.simulated,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: [INFERENCE_SERVICE_KEY],
      configSchema: {
        type: 'object',
        properties: {
          delayMs: { type: 'integer', minimum: 0, maximum: 60_000 },
          replies: {
            type: 'array',
            maxItems: 100,
            items: {
              oneOf: [
                {
                  type: 'object',
                  required: ['kind', 'text'],
                  properties: { kind: { const: 'text' }, text: { type: 'string' } },
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  required: ['kind', 'toolId', 'input'],
                  properties: { kind: { const: 'tool' }, toolId: { type: 'string' }, input: {} },
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    (ctx, rawConfig) => {
      const configured = parseSimulatedConfig(rawConfig);
      ctx.provide(
        INFERENCE_SERVICE_KEY,
        new SimulatedInference({
          replies: configured.replies ?? defaults.replies,
          delayMs: configured.delayMs ?? defaults.delayMs,
          responder: defaults.responder,
        }),
      );
    },
  );
}

function parseAiSdkConfig(config: Record<string, unknown>): AiSdkInferencePluginConfig {
  assertKnownKeys(config, ['model', 'credentialId', 'instructions', 'maxOutputTokens']);
  if (typeof config.model !== 'string' || !config.model)
    throw new TypeError('AI SDK inference requires model');
  if (
    config.credentialId !== undefined &&
    (typeof config.credentialId !== 'string' || !config.credentialId)
  ) {
    throw new TypeError('credentialId must be a non-empty string');
  }
  if (config.instructions !== undefined && typeof config.instructions !== 'string')
    throw new TypeError('instructions must be a string');
  if (
    config.maxOutputTokens !== undefined &&
    (!Number.isInteger(config.maxOutputTokens) ||
      Number(config.maxOutputTokens) < 1 ||
      Number(config.maxOutputTokens) > 32_000)
  ) {
    throw new TypeError('maxOutputTokens must be an integer between 1 and 32000');
  }
  return {
    model: config.model,
    credentialId: config.credentialId as string | undefined,
    instructions: config.instructions as string | undefined,
    maxOutputTokens: config.maxOutputTokens as number | undefined,
  };
}

function parseSimulatedConfig(config: Record<string, unknown>): {
  replies?: InferenceReply[];
  delayMs?: number;
} {
  assertKnownKeys(config, ['replies', 'delayMs']);
  if (
    config.delayMs !== undefined &&
    (!Number.isInteger(config.delayMs) ||
      Number(config.delayMs) < 0 ||
      Number(config.delayMs) > 60_000)
  ) {
    throw new TypeError('delayMs must be an integer between 0 and 60000');
  }
  if (config.replies !== undefined && !Array.isArray(config.replies))
    throw new TypeError('replies must be an array');
  const replies = (config.replies as unknown[] | undefined)?.map((reply, index) =>
    parseReply(reply, index),
  );
  return { replies, delayMs: config.delayMs as number | undefined };
}

function parseReply(reply: unknown, index: number): InferenceReply {
  if (typeof reply !== 'object' || reply === null || !('kind' in reply))
    throw new TypeError(`Invalid simulated reply at index ${index}`);
  const value = reply as Record<string, unknown>;
  if (value.kind === 'text' && typeof value.text === 'string')
    return { kind: 'text', text: value.text };
  if (value.kind === 'tool' && typeof value.toolId === 'string' && Object.hasOwn(value, 'input')) {
    return { kind: 'tool', toolId: value.toolId, input: value.input };
  }
  throw new TypeError(`Invalid simulated reply at index ${index}`);
}

function assertKnownKeys(config: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(config).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`Unknown inference plugin config field: ${unknown}`);
}
