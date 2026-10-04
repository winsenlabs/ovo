import {
  EvaluationWorker,
  FIXTURE_EVALUATION_BINDING_VERSION,
  FixtureEvaluationExecutor,
  PostgresProviderEvaluationAuthorizations,
  PostgresEvaluationService,
  type EvaluationExecutor,
} from '@winsendotai/ovo-plugin-evaluations';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { NetPort } from '@winsendotai/ovo-contracts';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import type { SecretManager } from '@winsendotai/ovo-plugin-secrets';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { Pool } from 'pg';
import {
  createProviderEvaluationRuntime,
  evaluationHostFactories,
  StoreProviderEvaluationReleaseLoader,
  type ProviderEvaluationRuntimeOptions,
} from './provider-evaluation-runtime.ts';

export const EVALUATION_FIXTURE_BINDING_VERSION = FIXTURE_EVALUATION_BINDING_VERSION;

export interface EvaluationApiRuntimeConfig {
  databaseUrl: string;
  store: Pick<ControlStore, 'getRelease'>;
  workerId?: string;
  pollIntervalMs?: number;
  maxConnections?: number;
  maxJobsBeforeYield?: number;
  providerEvaluations?: {
    ledger: CostLedgerService;
    secrets: SecretManager;
    maxCaseDurationMs?: number;
    maxProviderRequestsPerCase?: number;
    maxOutputTokens?: number;
    inferenceFactory?: ProviderEvaluationRuntimeOptions['inferenceFactory'];
    catalog?: readonly PluginDefinition[];
    net?: NetPort;
  };
  environment?: { OVO_PROVIDER_EVALUATIONS_ENABLED?: string };
  onError?(error: unknown): void;
}

/**
 * Owns only the evaluation pool and fixture worker. The control store remains
 * owned by API bootstrap and is used solely to load immutable releases.
 */
export async function createEvaluationApiRuntime(config: EvaluationApiRuntimeConfig) {
  const validated = validateConfig(config);
  const providerEnabled = validated.environment.OVO_PROVIDER_EVALUATIONS_ENABLED === 'true';
  const providerOptions = validated.providerEvaluations;
  if (providerEnabled && !providerOptions)
    throw new TypeError('Provider evaluation dependencies are required when enabled');
  const pool = new Pool({ connectionString: validated.databaseUrl, max: validated.maxConnections });
  try {
    const releases = new StoreProviderEvaluationReleaseLoader(validated.store);
    let provider: ReturnType<typeof createProviderEvaluationRuntime>;
    let authorizations: PostgresProviderEvaluationAuthorizations | undefined;
    if (providerEnabled) {
      if (!providerOptions) throw new TypeError('Provider evaluation dependencies are required');
      authorizations = new PostgresProviderEvaluationAuthorizations(
        pool,
        providerOptions.ledger,
        releases,
      );
      provider = createProviderEvaluationRuntime(
        {
          ...providerOptions,
          store: validated.store,
          authorizations,
          hostFactories: evaluationHostFactories,
        },
        validated.environment,
      );
    }
    const service = new PostgresEvaluationService({ pool }, provider?.providerGate, authorizations);
    await service.migrate();
    const executors: EvaluationExecutor[] = [
      new FixtureEvaluationExecutor(evaluationHostFactories),
    ];
    if (provider) executors.push(provider.providerExecutor);
    const worker = new EvaluationWorker(service, releases, executors);
    return new EvaluationApiRuntime(
      service,
      worker,
      validated.workerId,
      validated.pollIntervalMs,
      validated.maxJobsBeforeYield,
      validated.onError,
      pool,
    );
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export class EvaluationApiRuntime {
  readonly fixtureBindingVersion = EVALUATION_FIXTURE_BINDING_VERSION;
  private controller?: AbortController;
  private running?: Promise<void>;
  private closed = false;

  constructor(
    readonly service: PostgresEvaluationService,
    readonly worker: EvaluationWorker,
    private readonly workerId: string,
    private readonly pollIntervalMs: number,
    private readonly maxJobsBeforeYield: number,
    private readonly onError: (error: unknown) => void,
    private readonly pool?: Pool,
  ) {}

  start(): void {
    if (this.closed) throw new Error('Evaluation runtime is closed');
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.loop(this.controller.signal).finally(() => {
      this.controller = undefined;
      this.running = undefined;
    });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort(new DOMException('Evaluation runtime is shutting down', 'AbortError'));
    try {
      await this.running;
    } finally {
      try {
        await this.service.close();
      } finally {
        await this.pool?.end();
      }
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let worked = false;
      try {
        for (let index = 0; index < this.maxJobsBeforeYield && !signal.aborted; index += 1) {
          const run = await this.worker.runOnce(this.workerId, signal);
          if (!run) break;
          worked = true;
        }
      } catch (error) {
        if (signal.aborted) return;
        this.onError(error);
      }
      if (!worked) await delay(this.pollIntervalMs, signal);
      else await delay(0, signal);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
function required(value: string, name: string) {
  if (!value.trim()) throw new TypeError(`${name} is required`);
  return value;
}
function bounded(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}
function optionalBounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  name: string,
) {
  return value === undefined ? undefined : bounded(value, minimum, maximum, name);
}

function validateConfig(config: EvaluationApiRuntimeConfig) {
  if (!config.store || typeof config.store.getRelease !== 'function')
    throw new TypeError('store.getRelease is required');
  if (config.onError !== undefined && typeof config.onError !== 'function')
    throw new TypeError('onError must be a function');
  const environment = config.environment ?? process.env;
  if (environment.OVO_PROVIDER_EVALUATIONS_ENABLED === 'true' && !config.providerEvaluations)
    throw new TypeError('Provider evaluation dependencies are required when enabled');
  return {
    databaseUrl: required(config.databaseUrl, 'databaseUrl'),
    store: config.store,
    workerId:
      config.workerId === undefined
        ? `api-evaluations-${process.pid}`
        : required(config.workerId, 'workerId'),
    pollIntervalMs: bounded(config.pollIntervalMs ?? 1_000, 50, 60_000, 'pollIntervalMs'),
    maxConnections: bounded(config.maxConnections ?? 4, 1, 20, 'maxConnections'),
    maxJobsBeforeYield: bounded(config.maxJobsBeforeYield ?? 10, 1, 100, 'maxJobsBeforeYield'),
    providerEvaluations: config.providerEvaluations
      ? {
          ...config.providerEvaluations,
          maxCaseDurationMs: optionalBounded(
            config.providerEvaluations.maxCaseDurationMs,
            10,
            120_000,
            'providerEvaluations.maxCaseDurationMs',
          ),
          maxProviderRequestsPerCase: optionalBounded(
            config.providerEvaluations.maxProviderRequestsPerCase,
            1,
            20,
            'providerEvaluations.maxProviderRequestsPerCase',
          ),
          maxOutputTokens: optionalBounded(
            config.providerEvaluations.maxOutputTokens,
            1,
            8_192,
            'providerEvaluations.maxOutputTokens',
          ),
        }
      : undefined,
    environment,
    onError: config.onError ?? (() => undefined),
  };
}
