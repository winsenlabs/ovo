import { Cap, type Logger, type TurnDetectorFactory } from '@winsendotai/ovo-contracts';
import { definePluginV2 } from '@winsendotai/ovo-sdk';
import { z } from 'zod';
import { DetectorConfigSchema } from './config.ts';
import { ModelGate } from './model-gate.ts';
import { ShadowGate } from './model-shadow-gate.ts';
import {
  ModelDetectorConfigSchema,
  ModelGateConfigSchema,
  type ControllerInput,
  type EndOfTurnModel,
  type ModelGatedTurnController,
} from './model-gate-config.ts';
import type { TurnShadowEvent } from './model-shadow.ts';
import { TurnController } from './controller.ts';
import { turnShadowTelemetry } from './model-shadow-telemetry.ts';

export interface ModelDetectorOptions {
  /** Receives what the model would have decided in `shadow` mode. */
  onShadow?: (event: TurnShadowEvent) => void;
  /** A reading that failed or ran out of time: the turn ended as the rules decided. */
  onFault?: (fault: 'timeout' | 'failure') => void;
}

/**
 * A turn detector whose turn ends are read by `model` (the model gate, model-gate.ts). `row` is a
 * ModelDetectorConfigSchema row: the rules detector's own row plus `model` and `mode`.
 */
export function createModelTurnDetector(
  row: unknown,
  model: EndOfTurnModel,
  options: ModelDetectorOptions = {},
): { create(input: ControllerInput): ModelGatedTurnController } {
  const { model: gate, mode, ...rules } = ModelDetectorConfigSchema.parse(row ?? {});
  const read = watched(model, gate.timeoutMs, options.onFault);
  return {
    create: (input) =>
      mode === 'shadow'
        ? new ShadowGate(rules, gate, model, input, (event) => options.onShadow?.(event))
        : new ModelGate(rules, gate, read, input),
  };
}

/**
 * `model`, reporting each reading that fails or runs past `timeoutMs`: the gate then ends that turn
 * as the rules decided (it keeps its own count in `stats`; this tells the host).
 */
function watched(
  model: EndOfTurnModel,
  timeoutMs: number,
  onFault?: (fault: 'timeout' | 'failure') => void,
): EndOfTurnModel {
  if (!onFault) return model;
  return {
    name: model.name,
    input: model.input,
    threshold: (language) => model.threshold(language),
    predict(request) {
      let result: number | Promise<number>;
      try {
        result = model.predict(request);
      } catch (error) {
        onFault('failure');
        throw error;
      }
      if (typeof result === 'number') return result;
      const timer = setTimeout(() => onFault('timeout'), timeoutMs);
      return result.then(
        (probability) => (clearTimeout(timer), probability),
        (error: unknown) => {
          clearTimeout(timer);
          onFault('failure');
          throw error;
        },
      );
    },
  };
}

/** What a distribution decides about one model's detector: its defaults, and its rules in `active`. */
export interface ModelDetectorDefaults {
  /** The mode of an agent that does not choose one. Shadow changes nothing in a call. */
  mode: 'shadow' | 'active';
  /** Defaults for the gate's settings that the model's own packaging recommends. */
  recheckMs?: number;
  threshold?: number;
}

/** The row schema of a model detector plugin, with the distribution's defaults for the gate. */
export function modelDetectorSchema(defaults: ModelDetectorDefaults) {
  const gate = ModelGateConfigSchema.extend({
    recheckMs: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .default(defaults.recheckMs ?? 0),
    threshold:
      defaults.threshold === undefined
        ? z.number().min(0).max(1).optional()
        : z.number().min(0).max(1).default(defaults.threshold),
  });
  return DetectorConfigSchema.extend({
    mode: z.enum(['shadow', 'active']).default(defaults.mode),
    model: gate.default(() => gate.parse({})),
  });
}

/**
 * A turn-detector plugin for one end-of-turn model. The model loads once (on the first session) and
 * is shared by every session after it, so a model must take overlapping predictions. Registered by
 * the distribution, which may import the model packages (a plugin may not). Its turn@1 claim is
 * checked twice (tests/model-gate.test.ts): in full with a model that reads every turn finished, and
 * with one that holds every turn on all but the five checks that expect a turn to end the moment
 * the rules end it (the hold delays that by up to holdMs, by design).
 *
 * `options` makes it a production selection: the detector runs as the agent chose (`mode`), and the
 * model failing to load never fails the session: the agent gets the rules detector, exactly as
 * authored (its trailing-word holds on), and the failure is logged and counted. In `active` mode
 * the rules' own trailing-word holds are switched off (the model's hold replaces them); in `shadow`
 * they stay, so the call behaves exactly as it does with the default detector.
 */
export function modelTurnDetectorPlugin(
  spec: { id: string; provider: string; version?: string },
  load: () => Promise<EndOfTurnModel>,
  options: ModelDetectorDefaults & { retryLoadMs?: number; loadWaitMs?: number } = {
    mode: 'active',
  },
) {
  const schema = modelDetectorSchema(options);
  let loaded: Promise<EndOfTurnModel> | undefined;
  let failedAt: number | undefined;
  const retryMs = options.retryLoadMs ?? 60_000;
  const loadWaitMs = options.loadWaitMs ?? 2000;
  const model = (logger: Logger): Promise<EndOfTurnModel | undefined> => {
    // A failed load is retried (after a pause) on a later session: a model file that appears
    // later, or a worker thread that failed once, needs no restart of the worker.
    if (loaded === undefined || (failedAt !== undefined && Date.now() - failedAt >= retryMs)) {
      failedAt = undefined;
      loaded = load();
      loaded.catch((error: unknown) => {
        failedAt = Date.now();
        turnShadowTelemetry.unavailable();
        logger.error('turn_model_unavailable', { model: spec.id, error: describe(error) });
      });
    }
    return loaded.catch(() => undefined);
  };
  return definePluginV2(
    {
      id: spec.id,
      version: spec.version ?? '0.1.0',
      scope: 'session',
      kind: 'turn-detector',
      provider: spec.provider,
      provides: [Cap.turnDetector],
      config: schema,
      conformance: ['turn@1'],
    },
    async (ctx, config) => {
      const ready = await within(model(ctx.logger), loadWaitMs);
      const rules: TurnDetectorFactory = {
        create: (input) => new TurnController(rulesOf(config), input),
      };
      if (!ready) {
        turnShadowTelemetry.fellBack();
        ctx.logger.warn('turn_model_fallback', { model: spec.id, to: 'rules' });
        ctx.provide(Cap.turnDetector, rules);
        return;
      }
      const row =
        config.mode === 'active' ? { ...config, cutoffHoldMs: 0, pauseHoldMs: 0 } : config;
      const onShadow = (event: TurnShadowEvent) => {
        turnShadowTelemetry.record(event);
        ctx.logger.info('turn_shadow', { ...event });
      };
      const onFault = (fault: 'timeout' | 'failure') => {
        turnShadowTelemetry.fault(fault);
        ctx.logger.warn('turn_model_fault', { model: spec.id, fault, fallback: 'rules' });
      };
      const detector = createModelTurnDetector(row, ready, { onShadow, onFault });
      ctx.provide(Cap.turnDetector, detector);
    },
  );
}

/** The rules detector's own row out of a model detector's. */
function rulesOf(config: Record<string, unknown>) {
  const { model: _model, mode: _mode, ...rules } = config;
  return rules;
}

/** `value`, or undefined if it takes longer than `ms` (a session never waits long on a model). */
async function within<T>(value: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([value, late]);
  } finally {
    clearTimeout(timer);
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
