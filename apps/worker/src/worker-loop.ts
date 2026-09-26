import type { Server } from 'node:http';
import type { DeliveryOutcome } from './worker-types.ts';
import { createInboundWorkerRuntime } from './inbound-runtime.ts';
import { createProductionWorkerMediaRuntime } from './worker-media-bootstrap.ts';
import { openWorkerProcess } from './worker-process.ts';
import { recordingRetentionDays } from './recording-runtime.ts';
import { terminateActiveSession } from './worker-cleanup.ts';
import { terminateOwnedJobAndFinalize } from './worker-termination.ts';
import { WorkerReporter } from './worker-reporter.ts';
import { env } from './worker-environment.ts';
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
  } = processRuntime;
  let mediaRuntime: ReturnType<typeof createProductionWorkerMediaRuntime>;
  const terminateCostedJob = (jobId: string, ownerEpoch: number, reason: string) =>
    terminateOwnedJobAndFinalize({
      jobId,
      ownerEpoch,
      reason,
      workerId,
      store,
      carriers,
      media: mediaRuntime,
      finalizeCost: (id) => costs.finalize(id),
    });
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
      terminateOwned: terminateCostedJob,
      onProtectionLost: (reason) => {
        status.state = 'draining';
        status.detail = reason;
        runner.beginDrain();
      },
      onSessionActive: (jobId) => {
        status.state = 'active';
        status.detail = `Active inbound job ${jobId}`;
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

  const reporter = new WorkerReporter({
    store,
    workerId,
    ownershipEpoch: workerEpoch,
    state: () => status.state,
    onFailure: (error) => {
      status.state = 'draining';
      status.detail = String(error);
      runner.beginDrain();
    },
  });
  await reporter.start();

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      status.state = 'draining';
      runner.beginDrain();
      await reporter.stop();
      await inFlight?.catch((error) => {
        status.detail = `shutdown admission failed: ${String(error)}`;
      });
      if (active) {
        try {
          await terminateCostedJob(active.jobId, active.lease.ownerEpoch, 'worker-shutdown');
        } catch (error) {
          status.detail = `outbound shutdown failed: ${String(error)}`;
        }
        active.lease.stop();
        await active.protection.release().catch((error) => {
          status.detail = `protection release failed: ${String(error)}`;
        });
      }
      try {
        await inboundRuntime?.close();
      } catch (error) {
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
  watchWorkerShutdown(input, shutdown);

  while (status.state !== 'draining') {
    if (active) {
      const route = await store.getSessionRoute(active.jobId);
      if (!route) {
        status.state = 'draining';
        status.detail = 'active-session-route-missing';
        runner.beginDrain();
        continue;
      }
      if (route.terminalAt) {
        active.lease.stop();
        await active.protection.release();
        await mediaRuntime.closeSession(route.sessionId, `carrier terminal: ${route.status}`);
        await costs.finalize(active.jobId);
        const job = await store.get(active.jobId);
        if (job) {
          const callId =
            typeof job.payload.callId === 'string' && job.payload.callId
              ? job.payload.callId
              : job.id;
          try {
            await controlStore.finishCall(job.workspaceId, callId, route.status);
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            continue;
          }
        }
        await store.releaseTerminalSession(active.jobId);
        active = undefined;
        await inboundRuntime?.resume();
        status.state = 'ready';
        status.detail = 'terminal session released';
        await reporter.report();
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
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
        if (outcome.kind === 'accepted') active = outcome;
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
