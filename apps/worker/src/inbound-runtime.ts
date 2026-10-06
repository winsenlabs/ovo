import type { Logger } from '@winsendotai/ovo-contracts';
import { createLogger, errorFields, logFailure } from '@winsendotai/ovo-plugin-kit';
import {
  ProtectionRenewal,
  type ClaimedJob,
  type DurableJob,
  type SessionRoute,
} from '@winsendotai/ovo-plugin-orchestration';
import type { InboundWorkerRuntimeInput } from './inbound-runtime-input.ts';
import {
  terminateInboundSession,
  type ActiveInboundSession,
} from './inbound-session-termination.ts';
import { InboundFloorLease } from './worker-reporter.ts';

const RENEW_INTERVAL_MS = 45_000;
const PROTECTION_RENEW_INTERVAL_MS = 120_000;
const JOB_LEASE_MS = 120_000;

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
  private draining = false;
  private failed = false;
  private renewing = false;
  private readonly floorLease: InboundFloorLease;
  private readonly log: Logger;
  private activeSession?: ActiveInboundSession;

  constructor(private readonly input: InboundWorkerRuntimeInput) {
    this.slotId = `${input.workerId}:inbound`;
    this.log = input.logger ?? createLogger({ service: 'worker', workerId: input.workerId });
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

  /** True while an admitted inbound call is still running on this worker. */
  get hasActiveSession(): boolean {
    return this.activeSession !== undefined;
  }

  /** OPS-6 SIGTERM: advertise no capacity, but keep renewing the active call until it ends. */
  async beginDrain(): Promise<void> {
    if (this.stopped || this.failed || this.draining) return;
    this.draining = true;
    this.suspended = true;
    await this.register(false).catch(logFailure(this.log, 'inbound_deregister_failed'));
    await this.floorLease.release().catch(logFailure(this.log, 'inbound_floor_release_failed'));
  }

  async suspendForOutbound(): Promise<boolean> {
    if (this.stopped || this.failed || this.draining || this.suspended) return false;
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
    if (this.stopped || this.failed || this.draining || !this.suspended) return;
    this.suspended = false;
    if (await this.floorLease.claim()) {
      try {
        await this.activateIdleCapacity();
      } catch (error) {
        this.log.error('inbound_protection_restore_failed', errorFields(error));
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
    this.log.warn('inbound_cost_admission_blocked', { jobId: job.id, reason });
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

  /** OBS-11: reconciled terminal status releases the inbound capacity. */
  releaseCarrierCall = async (id: string) =>
    (await this.input.operations.inbound.releaseByCarrierCallId(id)) &&
    this.input.operations.calls.markTerminalByCarrierCallId(id);

  completeSession(jobId: string): void {
    if (this.activeSession?.jobId !== jobId) return;
    this.activeSession = undefined;
    void this.resume()
      .then(() => {
        if (!this.failed && !this.stopped && !this.draining) this.input.onSessionIdle?.(jobId);
      })
      .catch((error) =>
        this.failClosed(`inbound idle protection restore failed: ${String(error)}`),
      );
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const active = this.activeSession;
    this.activeSession = undefined;
    await this.register(false).catch(logFailure(this.log, 'inbound_deregister_failed'));
    try {
      if (active) await terminateInboundSession(this.input, active, 'worker-shutdown');
    } finally {
      try {
        await this.floorLease.release();
      } finally {
        await this.protectionRenewal?.release();
        this.protectionRenewal = undefined;
      }
    }
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
    const active = this.activeSession;
    this.log.error('inbound_capacity_failed_closed', { reason, jobId: active?.jobId });
    try {
      this.input.onProtectionLost(reason);
    } catch (error) {
      // Carrier termination must continue even when the drain observer fails.
      this.log.error('inbound_drain_observer_failed', errorFields(error));
    }
    this.activeSession = undefined;
    await this.floorLease.release().catch(logFailure(this.log, 'inbound_floor_release_failed'));
    const settled = await Promise.allSettled([
      this.register(false),
      ...(active ? [terminateInboundSession(this.input, active, reason)] : []),
    ]);
    for (const failure of settled)
      if (failure.status === 'rejected')
        this.log.error('inbound_fail_closed_step_failed', errorFields(failure.reason));
  }
}
