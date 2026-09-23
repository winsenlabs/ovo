import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import type {
  ClaimedJob,
  DurableJob,
  DurableJobStore,
  SessionRoute,
  TaskProtection,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ProductionWorkerCostRuntime } from './cost-runtime.ts';

const PROTECTION_WINDOW_MS = 120_000;
const RENEW_INTERVAL_MS = 45_000;

type InboundWorkerRuntimeInput = ConstructorParameters<typeof InboundWorkerRuntime>[0];

export function createInboundWorkerRuntime(
  enabled: boolean,
  input: InboundWorkerRuntimeInput,
): InboundWorkerRuntime | undefined {
  return enabled ? new InboundWorkerRuntime(input) : undefined;
}

export class InboundWorkerRuntime {
  private readonly slotId: string;
  private timer?: NodeJS.Timeout;
  private suspended = false;
  private stopped = false;
  private failed = false;
  private renewing = false;
  private activeSession?: {
    jobId: string;
    workerId: string;
    ownerEpoch: number;
    carrierCallId?: string;
  };

  constructor(
    private readonly input: {
      workerId: string;
      workerEndpoint: string;
      generation: number;
      protection: TaskProtection;
      operations: OperationsService;
      store: DurableJobStore;
      telephony: TelephonyControl;
      costs: ProductionWorkerCostRuntime;
      terminateOwned?: (jobId: string, ownerEpoch: number, reason: string) => Promise<boolean>;
      onProtectionLost: (reason: string) => void;
      onSessionActive?: (jobId: string) => void;
      onSessionIdle?: (jobId: string) => void;
    },
  ) {
    this.slotId = `${input.workerId}:inbound`;
  }

  async start(): Promise<void> {
    if (!(await this.input.protection.establish()))
      throw new Error('Unable to establish task protection for inbound capacity');
    try {
      if (!(await this.register(true))) throw new Error('Unable to register inbound capacity');
    } catch (error) {
      await this.input.protection.release();
      throw error;
    }
    this.timer = setInterval(() => void this.renew(), RENEW_INTERVAL_MS);
    this.timer.unref();
  }

  async suspendForOutbound(): Promise<boolean> {
    if (this.stopped || this.failed || this.suspended) return false;
    const suspended = await this.input.operations.inbound.suspendProtectedCapacity({
      slotId: this.slotId,
      workerId: this.input.workerId,
      generation: this.input.generation,
    });
    if (suspended) this.suspended = true;
    return suspended;
  }

  async resume(): Promise<void> {
    if (this.stopped || this.failed || !this.suspended) return;
    if (!(await this.input.protection.establish())) {
      this.input.onProtectionLost('failed to re-establish inbound task protection');
      return;
    }
    if (!(await this.register(true))) {
      this.input.onProtectionLost('failed to re-register inbound protected capacity');
      return;
    }
    this.suspended = false;
  }

  async admitSession(job: DurableJob, route: SessionRoute): Promise<void> {
    if (job.payload.kind !== 'inbound_call') return;
    const admission = await this.input.costs.reserve(
      job as ClaimedJob,
      job.payload,
      route.sessionId,
    );
    if (admission.admitted) {
      admission.beginActiveCall();
      this.activeSession = {
        jobId: job.id,
        workerId: route.workerId,
        ownerEpoch: route.ownerEpoch,
        carrierCallId: route.carrierCallId,
      };
      this.input.onSessionActive?.(job.id);
      return;
    }
    const reason = `inbound cost admission blocked: ${admission.reason}`;
    if (this.input.terminateOwned) {
      await this.input.terminateOwned(job.id, route.ownerEpoch, reason);
      throw new Error(reason);
    }
    await this.input.store.requestSessionTermination(
      job.id,
      route.workerId,
      route.ownerEpoch,
      reason,
    );
    if (route.carrierCallId) await this.input.telephony.hangup(route.carrierCallId);
    throw new Error(reason);
  }

  completeSession(jobId: string): void {
    if (this.activeSession?.jobId !== jobId) return;
    this.activeSession = undefined;
    this.input.onSessionIdle?.(jobId);
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.register(false).catch(() => undefined);
    await this.input.protection.release();
  }

  private async register(ready: boolean): Promise<boolean> {
    return this.input.operations.inbound.registerProtectedCapacity({
      slotId: this.slotId,
      workerId: this.input.workerId,
      workerEndpoint: this.input.workerEndpoint,
      generation: this.input.generation,
      ready,
      protectedUntil: new Date(Date.now() + (ready ? PROTECTION_WINDOW_MS : 0)),
    });
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.failed || this.renewing) return;
    this.renewing = true;
    try {
      if (!(await this.input.protection.renew())) {
        await this.failClosed('inbound task protection renewal failed');
        return;
      }
      const active = this.activeSession;
      if (active) {
        let owned: boolean;
        try {
          owned = await this.input.store.heartbeat(
            active.jobId,
            active.workerId,
            active.ownerEpoch,
            PROTECTION_WINDOW_MS,
          );
        } catch (error) {
          if (this.activeSession !== active) return;
          await this.failClosed(
            `inbound job lease renewal unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        if (!owned && this.activeSession === active) {
          await this.failClosed('inbound job lease renewal was fenced');
          return;
        }
      }
      if (!this.suspended && !(await this.register(true))) {
        await this.failClosed('inbound capacity renewal was fenced');
      }
    } catch (error) {
      await this.failClosed(
        `inbound capacity renewal failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.renewing = false;
    }
  }

  private async failClosed(reason: string): Promise<void> {
    if (this.failed || this.stopped) return;
    this.failed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.input.onProtectionLost(reason);
    } catch {
      // Carrier termination must continue even when the drain observer fails.
    }
    const active = this.activeSession;
    this.activeSession = undefined;
    if (active && this.input.terminateOwned) {
      await Promise.allSettled([
        this.register(false),
        this.input.terminateOwned(active.jobId, active.ownerEpoch, reason),
      ]);
      return;
    }
    await Promise.allSettled([
      this.register(false),
      ...(active
        ? [
            this.input.store.requestSessionTermination(
              active.jobId,
              active.workerId,
              active.ownerEpoch,
              reason,
            ),
            active.carrierCallId
              ? this.input.telephony.hangup(active.carrierCallId)
              : Promise.resolve(),
          ]
        : []),
    ]);
  }
}
