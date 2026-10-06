import type { Server } from 'node:http';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';
import type { DeliveryOutcome } from './worker-types.ts';
import { createInboundWorkerRuntime } from './inbound-runtime.ts';
import { createProductionWorkerMediaRuntime } from './worker-media-bootstrap.ts';
import { openWorkerProcess } from './worker-process.ts';
import { recordingRetentionDays } from './recording-runtime.ts';
import { terminateActiveSession } from './worker-cleanup.ts';
import { terminateOwnedJobAndFinalize } from './worker-termination.ts';
import { settleTerminalSession } from './terminal-session.ts';
import { WorkerReporter } from './worker-reporter.ts';
import { env } from './worker-environment.ts';
import { ActiveCallDrain } from './worker-drain.ts';
import { watchWorkerShutdown, type WorkerStatus } from './worker-health.ts';

export type { WorkerStatus } from './worker-health.ts';

/** Delivery loop and active-session supervision; process composition lives in worker-process. */
export async function runWorkerLoop(input: {
  status: WorkerStatus;
  server: Server;
  openProcess?: typeof openWorkerProcess;
  createMedia?: typeof createProductionWorkerMediaRuntime;
  registerShutdown?: (callback: () => void) => void;
}): Promise<void> {
  const { status, server } = input;
  const processRuntime = await (input.openProcess ?? openWorkerProcess)();
  if (processRuntime.kind === 'dial-disabled') {
    status.state = 'dial-disabled';
    status.detail = 'Durable adapters composed; carrier admission is explicitly disabled';
    const shutdown = async () => {
      status.state = 'draining';
      await processRuntime.composition.dispose();
      server.close();
    };
    watchWorkerShutdown(input, shutdown);
    return;
  }
  const {
    workerId,
    workerEpoch,
    workerEndpoint,
    store,
    queue,
    runner,
    telephony,
    protection,
    operations,
    costs,
    recordings,
    controlStore,
    costLedger,
    telemetry,
    secrets,
    speechCache,
    extensions,
    composition,
    distribution,
    carriers,
    prewarm,
  } = processRuntime;
  const log = createLogger({ service: 'worker', workerId });
  let mediaRuntime: ReturnType<typeof createProductionWorkerMediaRuntime>;
  const terminateCostedJob = async (jobId: string, ownerEpoch: number, reason: string) => {
    try {
      return await terminateOwnedJobAndFinalize({
        jobId,
        ownerEpoch,
        reason,
        workerId,
        store,
        carriers,
        media: mediaRuntime,
        finalizeCost: (id) => costs.finalize(id),
      });
    } finally {
      inboundRuntime?.completeSession(jobId);
    }
  };
  const inboundRuntime = createInboundWorkerRuntime(
    process.env.OVO_INBOUND_CAPACITY_ENABLED === 'true',
    {
      workerId,
      workerEndpoint,
      generation: workerEpoch,
      protection,
      operations,
      store,
      floor: store,
      organizationId:
        process.env.OVO_INBOUND_CAPACITY_ENABLED === 'true' ? env('OVO_ORGANIZATION_ID') : '',
      inboundWarmFloor: Number(process.env.OVO_INBOUND_WARM_FLOOR ?? 0),
      telephony,
      costs,
      logger: log,
      terminateOwned: terminateCostedJob,
      onProtectionLost: (reason) => {
        status.state = 'draining';
        status.detail = reason;
        runner.beginDrain();
      },
      onSessionActive: (jobId) => {
        status.state = 'active';
        status.detail = `Active inbound job ${jobId}`;
        void prewarm?.(jobId);
      },
      onSessionIdle: () => {
        status.state = 'ready';
        status.detail = 'Inbound session closed';
      },
    },
  );
  let active: Extract<DeliveryOutcome, { kind: 'accepted' }> | undefined;
  let inFlight: Promise<DeliveryOutcome> | undefined;
  const draining = () => status.state === 'draining';
  mediaRuntime = (input.createMedia ?? createProductionWorkerMediaRuntime)({
    httpServer: server,
    gatewayUrl: env('OVO_MEDIA_GATEWAY_WS_URL'),
    gatewayToken: env('OVO_MEDIA_WORKER_TOKEN'),
    workerId,
    onDisconnect: (reason) => {
      status.state = 'draining';
      status.detail = `media-gateway:${reason}`;
      runner.beginDrain();
      if (active)
        void terminateActiveSession({
          active,
          reason: 'media-gateway-disconnected',
          workerId,
          store,
          telephony,
          carriers,
          media: mediaRuntime,
        });
    },
    store,
    controlStore,
    secrets,
    telemetry,
    costs,
    extensions,
    recordings: recordings.live,
    recordingRetentionDays: recordingRetentionDays(),
    speechCache,
    telephony,
    carriers,
    inbound: inboundRuntime,
    graph: { distribution, parent: composition, carriers },
  });
  runner.setTerminationHandler(terminateCostedJob);
  costs.setTerminationHandler(async (job, reason) => {
    await terminateCostedJob(job.id, job.ownerEpoch ?? 0, reason);
  });
  await mediaRuntime.start();
  await inboundRuntime?.start();
  status.state = 'ready';
  status.detail = 'All required adapters composed; awaiting durable work';
  log.info('worker_ready', { inbound: inboundRuntime !== undefined });

  const reporter = new WorkerReporter({
    store,
    workerId,
    ownershipEpoch: workerEpoch,
    state: () => status.state,
    onFailure: (error) => {
      log.error('worker_reporter_failed', errorFields(error));
      status.state = 'draining';
      status.detail = String(error);
      runner.beginDrain();
    },
  });
  await reporter.start();

  const drain = new ActiveCallDrain({
    log,
    inbound: inboundRuntime,
    sessionActive: () => active !== undefined || inboundRuntime?.hasActiveSession === true,
    describe: () => ({ jobId: active?.jobId, inbound: inboundRuntime?.hasActiveSession ?? false }),
  });
  let shutdownPromise: Promise<void> | undefined;
  const stepFailed = (step: string, error: unknown) =>
    log.error('worker_shutdown_step_failed', { step, jobId: active?.jobId, ...errorFields(error) });
  /** `graceful` (SIGTERM) waits for the active call; an internal drain ends it at once. */
  const shutdown = (graceful = false) =>
    (shutdownPromise ??= (async () => {
      status.state = 'draining';
      log.info('worker_draining', { detail: status.detail, graceful });
      runner.beginDrain();
      await inFlight?.catch((error) => {
        stepFailed('admission', error);
        status.detail = `shutdown admission failed: ${String(error)}`;
      });
      // The reporter keeps the worker row leased (state draining) while the call finishes.
      if (graceful) await drain.wait();
      await reporter.stop();
      if (active) {
        try {
          await terminateCostedJob(active.jobId, active.lease.ownerEpoch, 'worker-shutdown');
        } catch (error) {
          stepFailed('outbound', error);
          status.detail = `outbound shutdown failed: ${String(error)}`;
        }
        active.lease.stop();
        await active.protection.release().catch((error) => {
          stepFailed('protection', error);
          status.detail = `protection release failed: ${String(error)}`;
        });
      }
      try {
        await inboundRuntime?.close();
      } catch (error) {
        stepFailed('inbound', error);
        status.detail = `inbound shutdown failed: ${String(error)}`;
      }
      await mediaRuntime.close('worker-shutdown');
      await telemetry.close();
      speechCache.close();
      await costLedger.close();
      await controlStore.close();
      await composition.dispose();
      server.close();
    })());
  watchWorkerShutdown(input, () => shutdown(true));

  // While a SIGTERM drain waits, the loop keeps settling the active outbound call.
  while (!draining() || (drain.waiting && active)) {
    if (active) {
      const route = await store.getSessionRoute(active.jobId);
      if (!route) {
        log.error('active_session_route_missing', { jobId: active.jobId });
        status.state = 'draining';
        status.detail = 'active-session-route-missing';
        runner.beginDrain();
        drain.abandon();
        continue;
      }
      if (route.terminalAt) {
        const settled = await settleTerminalSession({
          active,
          route,
          store,
          media: mediaRuntime,
          costs,
          controlStore,
          log,
        });
        if (!settled) continue;
        active = undefined;
        if (draining()) continue;
        await inboundRuntime?.resume();
        status.state = 'ready';
        status.detail = 'terminal session released';
        await reporter.report();
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    if (draining()) break;
    const deliveries = await queue.receive({
      maxMessages: 1,
      waitSeconds: 20,
      visibilitySeconds: 120,
    });
    for (const delivery of deliveries) {
      if (draining()) break;
      if (inboundRuntime && !(await inboundRuntime.suspendForOutbound())) {
        status.detail = 'Inbound capacity is reserved; deferred outbound delivery';
        await runner.defer(delivery, 'inbound-reserved');
        continue;
      }
      if (draining()) break;
      status.state = 'reserved';
      status.detail = 'Admitting outbound delivery';
      inFlight = (async () => {
        await reporter.reportReserved();
        const outcome = await runner.handle(delivery);
        if (outcome.kind === 'accepted') {
          active = outcome;
          // While the callee's phone rings: the first turn then skips DNS+TCP+TLS (LAT-8).
          void prewarm?.(outcome.jobId);
        }
        return outcome;
      })();
      const outcome = await inFlight;
      inFlight = undefined;
      if (draining()) break;
      if (outcome.kind === 'accepted') {
        status.state = 'active';
        status.detail = `Active carrier leg ${outcome.carrierCallId ?? outcome.carrierRequestId}`;
      } else if (outcome.kind === 'deferred' && outcome.reason.includes('protection')) {
        status.state = 'draining';
        status.detail = outcome.reason;
        runner.beginDrain();
      } else {
        status.state = 'ready';
        status.detail = outcome.kind;
        await inboundRuntime?.resume();
      }
      await reporter.report();
    }
  }
  await shutdown();
}
