import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import {
  ProtectionRenewal,
  type TaskProtection,
  type ClaimedJob,
  type DurableJob,
  type DurableJobStore,
  type PostgresOrchestrationStore,
  type SessionRoute,
  type TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ProductionWorkerCostRuntime } from './cost-runtime.ts';
import { InboundFloorLease } from './worker-reporter.ts';

const RENEW_INTERVAL_MS = 45_000;
const PROTECTION_RENEW_INTERVAL_MS = 120_000;
const JOB_LEASE_MS = 120_000;

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
  private protectionRenewal?: ProtectionRenewal;
  private suspended = false;
  private stopped = false;
  private failed = false;
  private renewing = false;
  private readonly floorLease: InboundFloorLease;
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
      floor: Pick<
        PostgresOrchestrationStore,
        'claimInboundFloorToken' | 'releaseInboundFloorToken'
      >;
      organizationId: string;
      inboundWarmFloor: number;
      telephony: TelephonyControl;
      costs: ProductionWorkerCostRuntime;
      terminateOwned?: (jobId: string, ownerEpoch: number, reason: string) => Promise<boolean>;
      onProtectionLost: (reason: string) => void;
      onSessionActive?: (jobId: string) => void;
      onSessionIdle?: (jobId: string) => void;
    },
  ) {
    this.slotId = `${input.workerId}:inbound`;
    this.floorLease = new InboundFloorLease(
      input.floor,
      input.workerId,
      input.organizationId,
      input.generation,
      input.inboundWarmFloor,
    );
  }

  async start(): Promise<void> {
    if (await this.floorLease.claim()) await this.activateIdleCapacity();
    else await this.register(false);
    this.timer = setInterval(() => void this.renew(), RENEW_INTERVAL_MS);
    this.timer.unref();
  }

  async suspendForOutbound(): Promise<boolean> {
    if (this.stopped || this.failed || this.suspended) return false;
    if (this.floorLease.isHeld) {
      const suspended = await this.input.operations.inbound.suspendProtectedCapacity({
        slotId: this.slotId,
        workerId: this.input.workerId,
        generation: this.input.generation,
      });
      if (!suspended) return false;
      await this.floorLease.release();
      await this.protectionRenewal?.release();
      this.protectionRenewal = undefined;
    }
    this.suspended = true;
    return true;
  }

  async resume(): Promise<void> {
    if (this.stopped || this.failed || !this.suspended) return;
    this.suspended = false;
    if (await this.floorLease.claim()) {
      try {
        await this.activateIdleCapacity();
      } catch {
        await this.failClosed('failed to re-establish inbound task protection');
      }
    } else {
      await this.register(false);
      await this.protectionRenewal?.release();
      this.protectionRenewal = undefined;
    }
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
      this.suspended = true;
      this.activeSession = {
        jobId: job.id,
        workerId: route.workerId,
        ownerEpoch: route.ownerEpoch,
        carrierCallId: route.carrierCallId,
      };
      try {
        await this.floorLease.release();
        await this.register(false);
      } catch (error) {
        await this.failClosed(`inbound floor release failed: ${String(error)}`);
        throw error;
      }
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
    void this.resume()
      .then(() => {
        if (!this.failed && !this.stopped) this.input.onSessionIdle?.(jobId);
      })
      .catch((error) =>
        this.failClosed(`inbound idle protection restore failed: ${String(error)}`),
      );
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.register(false).catch(() => undefined);
    await this.floorLease.release();
    await this.protectionRenewal?.release();
  }

  private async activateIdleCapacity(): Promise<void> {
    this.protectionRenewal ??= new ProtectionRenewal(
      this.input.protection,
      PROTECTION_RENEW_INTERVAL_MS,
      () => this.failClosed('inbound task protection renewal failed'),
    );
    try {
      if (!(await this.protectionRenewal.establish()))
        throw new Error('Unable to establish task protection for inbound capacity');
      if (!(await this.register(true))) throw new Error('Unable to register inbound capacity');
    } catch (error) {
      await this.protectionRenewal.release();
      this.protectionRenewal = undefined;
      await this.floorLease.release();
      throw error;
    }
  }

  private async register(ready: boolean): Promise<boolean> {
    return this.input.operations.inbound.registerProtectedCapacity({
      slotId: this.slotId,
      workerId: this.input.workerId,
      workerEndpoint: this.input.workerEndpoint,
      generation: this.input.generation,
      ready,
      protectedUntil: ready
        ? (this.protectionRenewal?.protectedUntil() ?? new Date(0))
        : new Date(),
    });
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.failed || this.renewing) return;
    this.renewing = true;
    try {
      const active = this.activeSession;
      if (active) {
        let owned: boolean;
        try {
          owned = await this.input.store.heartbeat(
            active.jobId,
            active.workerId,
            active.ownerEpoch,
            JOB_LEASE_MS,
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
      if (!this.suspended) {
        if (!(await this.floorLease.claim())) {
          await this.register(false);
          await this.protectionRenewal?.release();
          this.protectionRenewal = undefined;
        } else if (!this.protectionRenewal) {
          await this.activateIdleCapacity();
        } else if (!(await this.register(true))) {
          await this.failClosed('inbound capacity renewal was fenced');
        }
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
    await this.floorLease.release().catch(() => undefined);
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
            (async () => {
              const fenced = await this.input.store.requestSessionTermination(
                active.jobId,
                active.workerId,
                active.ownerEpoch,
                reason,
              );
              if (fenced && active.carrierCallId)
                await this.input.telephony.hangup(active.carrierCallId);
            })(),
          ]
        : []),
    ]);
  }
}
