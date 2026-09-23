import {
  type DurableJobStore,
  type DurableQueue,
  type ReadinessProbe,
  type TaskProtection,
  type TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import { WorkerRunner } from './runner.ts';
import { CALL_RECORDER_SERVICE_KEY, type CallRecorder } from './call-recorder.ts';
import { WORKER_COST_RUNTIME_SERVICE_KEY, type WorkerCostRuntimePort } from './cost-runtime.ts';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';

export const createWorkerRunnerPlugin = (carriers: () => WorkerCarrierRuntime) =>
  definePlugin(
    {
      id: '@winsendotai/ovo-worker/runner',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [
        'orchestration.store',
        'orchestration.queue',
        'worker.readiness',
        'worker.protection',
        'telephony.control',
        'ovo.operations',
        CALL_RECORDER_SERVICE_KEY,
        WORKER_COST_RUNTIME_SERVICE_KEY,
      ],
      provides: ['worker.runner'],
      configSchema: {
        type: 'object',
        required: ['workerId', 'workerEndpoint', 'organizationId'],
        properties: {
          workerId: { type: 'string' },
          workerEndpoint: { type: 'string' },
          organizationId: { type: 'string' },
          streamUrl: { type: 'string' },
          statusCallbackUrl: { type: 'string' },
        },
      },
      secretFields: [],
    },
    (ctx: Context, config) => {
      if (typeof config.workerId !== 'string' || !config.workerId)
        throw new Error('Missing workerId');
      if (typeof config.workerEndpoint !== 'string' || !config.workerEndpoint)
        throw new Error('Missing workerEndpoint');
      if (typeof config.organizationId !== 'string' || !config.organizationId)
        throw new Error('Missing organizationId');
      const selectedCarriers = carriers();
      const operations = ctx.get('ovo.operations') as OperationsService;
      ctx.provide(
        'worker.runner',
        new WorkerRunner(
          config.workerId,
          ctx.get('orchestration.store') as DurableJobStore,
          ctx.get('orchestration.queue') as DurableQueue,
          ctx.get('worker.readiness') as ReadinessProbe,
          ctx.get('worker.protection') as TaskProtection,
          ctx.get('telephony.control') as TelephonyControl,
          {
            leaseMs: 60_000,
            protectionRenewMs: 120_000,
            deferSeconds: 5,
            visibilitySeconds: 120,
            workerEndpoint: config.workerEndpoint,
            organizationId: config.organizationId,
            handshakeTtlMs: 60_000,
            campaigns: operations.campaigns,
            carriers: selectedCarriers,
            callRecorder: ctx.get(CALL_RECORDER_SERVICE_KEY) as CallRecorder,
            cost: ctx.get(WORKER_COST_RUNTIME_SERVICE_KEY) as WorkerCostRuntimePort,
          },
        ),
      );
    },
  );
