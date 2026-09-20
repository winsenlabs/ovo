import {
  EvaluationWorker,
  FIXTURE_EVALUATION_BINDING_VERSION,
  FixtureEvaluationExecutor,
  PostgresEvaluationService,
  releaseEvaluationFingerprint,
  type ReleaseEvaluationSnapshot,
} from '@winsendotai/ovo-plugin-evaluations';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';

export const EVALUATION_FIXTURE_BINDING_VERSION = FIXTURE_EVALUATION_BINDING_VERSION;

export interface EvaluationApiRuntimeConfig {
  databaseUrl: string;
  store: Pick<ControlStore, 'getRelease'>;
  workerId?: string;
  pollIntervalMs?: number;
  maxConnections?: number;
  maxJobsBeforeYield?: number;
  onError?(error: unknown): void;
}

/**
 * Owns only the evaluation pool and fixture worker. The control store remains
 * owned by API bootstrap and is used solely to load immutable releases.
 */
export async function createEvaluationApiRuntime(config: EvaluationApiRuntimeConfig) {
  const validated = validateConfig(config);
  const service = new PostgresEvaluationService({
    connectionString: validated.databaseUrl,
    max: validated.maxConnections,
  });
  try {
    await service.migrate();
  } catch (error) {
    await service.close();
    throw error;
  }
  const releases = {
    async load(
      workspaceId: string,
      releaseId: string,
    ): Promise<ReleaseEvaluationSnapshot | undefined> {
      const release = await validated.store.getRelease(workspaceId, releaseId);
      if (!release) return undefined;
      return {
        id: release.id,
        fingerprint: releaseEvaluationFingerprint(release),
        config: structuredClone(release.config),
      };
    },
  };
  const worker = new EvaluationWorker(service, releases, [new FixtureEvaluationExecutor()]);
  return new EvaluationApiRuntime(
    service,
    worker,
    validated.workerId,
    validated.pollIntervalMs,
    validated.maxJobsBeforeYield,
    validated.onError,
  );
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
      await this.service.close();
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

function validateConfig(config: EvaluationApiRuntimeConfig) {
  if (!config.store || typeof config.store.getRelease !== 'function')
    throw new TypeError('store.getRelease is required');
  if (config.onError !== undefined && typeof config.onError !== 'function')
    throw new TypeError('onError must be a function');
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
    onError: config.onError ?? (() => undefined),
  };
}
