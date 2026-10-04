import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import { Cap } from '@winsendotai/ovo-contracts';
import type { PerformanceService } from '@winsendotai/ovo-plugin-observability';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import type { RecordingArchive } from '@winsendotai/ovo-plugin-recordings';
import type { PostgresEvaluationService } from '@winsendotai/ovo-plugin-evaluations';
import { getProductionRecordingServices } from '../recording-runtime.ts';
import { EVALUATION_FIXTURE_BINDING_VERSION } from '../evaluation-runtime.ts';
import { registerAgentsRoutes } from './agents.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerCostRoutes } from './cost.ts';
import { registerCredentialsRoutes } from './credentials.ts';
import { registerEvaluationDatasetRoutes } from './evaluation-datasets.ts';
import { registerInfrastructureRoutes } from './infrastructure.ts';
import { registerInspectionRoutes } from './inspection.ts';
import { registerMcpRoutes } from './mcp.ts';
import { registerOperationsRoutes } from './operations.ts';
import { registerPerformanceRoutes } from './performance.ts';
import { registerReadinessRoutes } from './readiness.ts';
import { registerRecordingLifecycleRoutes } from './recording-lifecycle.ts';
import { registerRecordingRoutes } from './recordings.ts';
import { registerSimulationRoutes } from './simulation.ts';
import { registerUserRoutes } from './users.ts';
import { registerPluginRoutes } from './plugins.ts';
import { registerTestCallRoutes } from './test-calls.ts';

/** One stable route inventory. Wave-2 units fill their stubs without editing api-plugin. */
export function registerApiRoutes(deps: any): void {
  const { app, store, users, options, ctx, requireRole, error } = deps;
  registerAuthRoutes(deps);
  registerUserRoutes({ app, users, store, requireTls: options.requireTlsForSecrets ?? false });
  registerAgentsRoutes(deps);
  registerReadinessRoutes(deps);
  registerPluginRoutes(deps);
  registerInfrastructureRoutes({
    app,
    store,
    requireRole,
    infrastructure: deps.infrastructure,
  });
  registerOperationsRoutes({
    app,
    store,
    requireRole,
    operations: options.operationsEnabled
      ? (ctx.get(Cap.operations) as OperationsService)
      : undefined,
  });
  registerEvaluationDatasetRoutes({
    app,
    store,
    requireRole,
    fixtureBindingVersion: EVALUATION_FIXTURE_BINDING_VERSION,
    evaluations: options.evaluationsEnabled
      ? (ctx.get(Cap.evaluations) as PostgresEvaluationService)
      : undefined,
  });
  registerPerformanceRoutes({
    app,
    store,
    requireRole,
    performance: options.telemetryEnabled
      ? (ctx.get(Cap.telemetry) as PerformanceService)
      : undefined,
  });
  registerCostRoutes({
    app,
    controlStore: store,
    requireRole,
    audit: (value) => store.audit(value),
    ledger: options.costLedgerEnabled ? (ctx.get(Cap.costLedger) as CostLedgerService) : undefined,
  });
  registerCredentialsRoutes(deps);
  registerMcpRoutes(deps);
  registerSimulationRoutes(deps);
  registerInspectionRoutes(deps);
  registerTestCallRoutes(deps);
  registerRecordingRoutes({
    app,
    store,
    recordings:
      options.fixtureRecordingsEnabled !== false
        ? (ctx.get(Cap.recordings) as RecordingArchive)
        : undefined,
    requireRole,
    error,
  });
  registerRecordingLifecycleRoutes({
    app,
    store,
    requireRole,
    error,
    recordings: options.productionRecordingsEnabled
      ? getProductionRecordingServices(ctx)
      : undefined,
  });
}
