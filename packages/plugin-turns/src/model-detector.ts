import { Cap } from '@winsendotai/ovo-contracts';
import { definePluginV2 } from '@winsendotai/ovo-sdk';
import { ModelGate } from './model-gate.ts';
import {
  ModelDetectorConfigSchema,
  type ControllerInput,
  type EndOfTurnModel,
  type ModelGatedTurnController,
} from './model-gate-config.ts';

/**
 * A turn detector whose turn ends are read by `model` (the model gate, model-gate.ts). `row` is a
 * ModelDetectorConfigSchema row: the rules detector's own row plus `model`.
 */
export function createModelTurnDetector(
  row: unknown,
  model: EndOfTurnModel,
): { create(input: ControllerInput): ModelGatedTurnController } {
  const { model: gate, ...rules } = ModelDetectorConfigSchema.parse(row ?? {});
  return { create: (input) => new ModelGate(rules, gate, model, input) };
}

/**
 * A turn-detector plugin for one end-of-turn model. The model loads once (on the first session) and
 * is shared by every session after it. Registered by the distribution, which may import the model
 * packages (a plugin may not).
 */
export function modelTurnDetectorPlugin(
  spec: { id: string; provider: string; version?: string },
  load: () => Promise<EndOfTurnModel>,
) {
  let loaded: Promise<EndOfTurnModel> | undefined;
  return definePluginV2(
    {
      id: spec.id,
      version: spec.version ?? '0.1.0',
      scope: 'session',
      kind: 'turn-detector',
      provider: spec.provider,
      provides: [Cap.turnDetector],
      config: ModelDetectorConfigSchema,
      conformance: ['turn@1'],
    },
    async (ctx, config) => {
      loaded ??= load().catch((error: unknown) => {
        loaded = undefined;
        throw error;
      });
      ctx.provide(Cap.turnDetector, createModelTurnDetector(config, await loaded));
    },
  );
}
