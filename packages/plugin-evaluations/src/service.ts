import { Pool } from 'pg';
import { EvaluationDatasets } from './datasets.ts';
import { FixtureEvaluationExecutor } from './executor.ts';
import { migrateEvaluations } from './migrations.ts';
import { EvaluationRuns } from './runs.ts';
import type {
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationRun,
  ExecutorKind,
  ReleaseEvaluationSnapshot,
} from './types.ts';

export interface EvaluationExecutor {
  kind: ExecutorKind;
  executeCase(
    run: EvaluationRun,
    release: ReleaseEvaluationSnapshot,
    testCase: EvaluationCase,
    signal?: AbortSignal,
  ): Promise<Omit<EvaluationCaseResult, 'runId' | 'workspaceId' | 'createdAt'>>;
  finalizeRun?(run: EvaluationRun): Promise<void>;
}
export interface EvaluationReleaseLoader {
  load(workspaceId: string, releaseId: string): Promise<ReleaseEvaluationSnapshot | undefined>;
}
export interface ProviderEvaluationGate {
  authorize(input: {
    workspaceId: string;
    datasetId: string;
    datasetVersion: number;
    releaseId: string;
    fixtureBindingVersion: string;
    budgetAuthorizationId?: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export class PostgresEvaluationService {
  readonly datasets: EvaluationDatasets;
  readonly runs: EvaluationRuns;
  private readonly pool: Pool;
  private readonly owned: boolean;

  constructor(
    config: { connectionString: string; max?: number } | { pool: Pool },
    private readonly providerGate?: ProviderEvaluationGate,
  ) {
    if ('connectionString' in config) {
      this.owned = true;
      this.pool = new Pool({ connectionString: config.connectionString, max: config.max ?? 4 });
    } else {
      this.owned = false;
      this.pool = config.pool;
    }
    this.datasets = new EvaluationDatasets(this.pool);
    this.runs = new EvaluationRuns(this.pool);
  }
  async migrate() {
    await migrateEvaluations(this.pool);
  }
  async close() {
    if (this.owned) await this.pool.end();
  }

  async createRun(
    input: Parameters<EvaluationRuns['create']>[0] & { budgetAuthorizationId?: string },
  ) {
    let providerAuthorized = false;
    if ((input.executorKind ?? 'fixture') === 'provider') {
      if (
        !(await this.datasets.getVersion(input.workspaceId, input.datasetId, input.datasetVersion))
      )
        throw Object.assign(new Error('Dataset version not found'), { statusCode: 404 });
      if (!this.providerGate)
        throw Object.assign(new Error('Provider evaluation is not configured'), {
          statusCode: 503,
        });
      await this.providerGate.authorize({
        workspaceId: input.workspaceId,
        datasetId: input.datasetId,
        datasetVersion: input.datasetVersion,
        releaseId: input.releaseId,
        fixtureBindingVersion: input.fixtureBindingVersion,
        budgetAuthorizationId: input.budgetAuthorizationId,
        idempotencyKey: input.idempotencyKey,
      });
      providerAuthorized = true;
    }
    return this.runs.create(
      {
        ...input,
        maxAttempts: (input.executorKind ?? 'fixture') === 'provider' ? 1 : input.maxAttempts,
      },
      { providerAuthorized },
    );
  }
}

export class EvaluationWorker {
  private readonly executors: Map<ExecutorKind, EvaluationExecutor>;
  constructor(
    private readonly service: PostgresEvaluationService,
    private readonly releases: EvaluationReleaseLoader,
    executors: EvaluationExecutor[] = [new FixtureEvaluationExecutor()],
  ) {
    this.executors = new Map(executors.map((executor) => [executor.kind, executor]));
  }

  async runOnce(ownerId: string, signal?: AbortSignal): Promise<EvaluationRun | undefined> {
    const run = await this.service.runs.claim(ownerId);
    if (!run) return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const heartbeat = setInterval(() => {
      void this.service.runs
        .heartbeat(run.workspaceId, run.id, ownerId, run.ownerEpoch)
        .then((current) => {
          if (current.status !== 'running')
            controller.abort(new DOMException('Evaluation cancelled', 'AbortError'));
        })
        .catch((error) => controller.abort(error));
    }, 10_000);
    let executor: EvaluationExecutor | undefined;
    try {
      const [version, release] = await Promise.all([
        this.service.datasets.getVersion(run.workspaceId, run.datasetId, run.datasetVersion),
        this.releases.load(run.workspaceId, run.releaseId),
      ]);
      if (!version || version.fingerprint !== run.datasetFingerprint)
        throw new Error('Immutable dataset version no longer matches run');
      if (!release || release.fingerprint !== run.releaseFingerprint)
        throw new Error('Immutable release snapshot no longer matches run');
      executor = this.executors.get(run.executorKind);
      if (!executor) throw new Error(`No ${run.executorKind} evaluation executor is configured`);
      const completed = await loadCompleted(this.service.runs, run);
      for (const testCase of version.cases) {
        controller.signal.throwIfAborted();
        if (completed.has(testCase.id)) continue;
        if (!(await this.service.runs.active(run.workspaceId, run.id, ownerId, run.ownerEpoch)))
          break;
        const result = await executor.executeCase(run, release, testCase, controller.signal);
        await this.service.runs.recordResult(run, result);
        await this.service.runs.heartbeat(run.workspaceId, run.id, ownerId, run.ownerEpoch);
      }
      await executor.finalizeRun?.(run);
      return await this.service.runs.finish(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const current = await this.service.runs.get(run.workspaceId, run.id);
        if (current?.status === 'cancelling') {
          await executor?.finalizeRun?.(run);
          return await this.service.runs.finish(run);
        }
        const failed = await this.service.runs.fail(run, message, retryable(error));
        if (failed.status !== 'queued') await executor?.finalizeRun?.(failed);
        return failed;
      } catch {
        return await this.service.runs.get(run.workspaceId, run.id);
      }
    } finally {
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
    }
  }
}

async function loadCompleted(runs: EvaluationRuns, run: EvaluationRun) {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await runs.listResults(run.workspaceId, run.id, 100, cursor);
    for (const result of page.items) ids.add(result.caseId);
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}
function retryable(error: unknown) {
  return !(error instanceof TypeError) && !String(error).includes('Immutable');
}
