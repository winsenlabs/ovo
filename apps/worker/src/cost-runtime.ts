import { liveSessionRequiresInput } from './live-input-policy.ts';
import { LIVE_COST_METER_KEYS } from '@winsendotai/ovo-plugin-kit';
export { LIVE_COST_METER_KEYS } from '@winsendotai/ovo-plugin-kit';
import type {
  DurableJob,
  DurableJobStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ProviderUsageSink } from './cost-policy-types.ts';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import { type ControlStore, type ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import { metersFor, type SessionDefaults } from '@winsendotai/ovo-session-host';
import type { ReleaseSelections } from '@winsendotai/ovo-contracts';
import type { SelectedJobCarrier } from './carrier-runtime.ts';
import {
  requiredCostMeterKeys,
  extendHeldCostReservations,
  selectedReleaseSelections,
} from './cost-policy-support.ts';
import {
  createWorkerCostPolicyAttachment,
  type WorkerCostPolicyAttachment,
} from './cost-policy.ts';

export interface CostAdmission {
  admitted: boolean;
  reason?: string;
  beginActiveCall(): void;
  releaseBeforeStart(): Promise<unknown>;
}

export interface WorkerCostRuntimePort {
  reserve(
    job: DurableJob,
    payload: Record<string, unknown>,
    sessionId: string,
    selected?: SelectedJobCarrier,
  ): Promise<CostAdmission>;
}

export const WORKER_COST_RUNTIME_SERVICE_KEY = 'worker.cost-runtime';

export function requiredLiveCostMeterKeys(
  release: Pick<ReleaseRecord, 'config'>,
  selected?: { selections: ReleaseSelections; registry: PluginRegistry },
): readonly string[] {
  return requiredCostMeterKeys(release, LIVE_COST_METER_KEYS, selected);
}

interface HeldSession {
  attachment: WorkerCostPolicyAttachment;
  startedAt?: number;
  carrierMeter?: string;
  carrierProvider: string;
  reservationId: string;
  holder: string;
  maxCallSeconds: number;
  job: DurableJob;
  extensionLost?: boolean;
}

export class ProductionWorkerCostRuntime implements WorkerCostRuntimePort {
  private terminationHandler?: (job: DurableJob, reason: string) => Promise<void>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly sessions = new Map<string, HeldSession>();

  constructor(
    private readonly ledger: CostLedgerService,
    private readonly control: ControlStore,
    private readonly orchestration: DurableJobStore,
    private readonly telephony: TelephonyControl,
    private readonly workerId: string,
    private readonly requirePolicy = true,
    private readonly registry?: PluginRegistry,
    private readonly defaults?: SessionDefaults,
  ) {}

  setTerminationHandler(handler: (job: DurableJob, reason: string) => Promise<void>): void {
    this.terminationHandler = handler;
  }

  async reserve(
    job: DurableJob,
    payload: Record<string, unknown>,
    sessionId: string,
    selected?: SelectedJobCarrier,
  ) {
    if (payload.kind === 'test') return noCostAdmission();
    const releaseId = text(payload.releaseId);
    if (!releaseId)
      return this.requirePolicy
        ? { ...noCostAdmission(), admitted: false, reason: 'release-id-required' }
        : noCostAdmission();
    const release = await this.control.getRelease(job.workspaceId, releaseId);
    const policy = release?.config.costPolicy;
    if (!policy)
      return this.requirePolicy
        ? { ...noCostAdmission(), admitted: false, reason: 'release-cost-policy-required' }
        : noCostAdmission();
    const selections = selected?.selections ?? this.releaseSelections(release);
    const selectedMeters =
      this.registry && selections
        ? metersFor(selections, this.registry, {
            requiresInput: liveSessionRequiresInput(release.config),
          })
        : [];
    const requiredMeterKeys = selectedMeters.length
      ? selectedMeters.map((row) => row.meter.key)
      : requiredLiveCostMeterKeys(release);
    const missingMeters = requiredMeterKeys.filter((meterKey) => !policy.priceCards[meterKey]);
    if (missingMeters.length)
      return {
        ...noCostAdmission(),
        admitted: false,
        reason: `cost-meter-unconfigured:${missingMeters.join(',')}`,
      };
    const inferenceRecord = release.providerBindings.inference;
    const inferenceModel = inferenceRecord?.config.model;
    const carrier = selectedMeters.find((row) => row.slot === 'carrier');
    const carrierMeter =
      carrier?.meter.key ?? (!selectedMeters.length ? LIVE_COST_METER_KEYS.carrier : undefined);
    const carrierCard = carrierMeter ? policy.priceCards[carrierMeter] : undefined;
    const carrierProvider =
      carrier && this.registry
        ? (manifestKeys(this.registry.get(carrier.pluginId)!.manifest).manifest.provider ??
          'carrier')
        : LIVE_COST_METER_KEYS.carrier.split('.')[0]!;
    const attachment = createWorkerCostPolicyAttachment({
      ledger: this.ledger,
      policy,
      workspaceId: job.workspaceId,
      sessionId,
      reservationHolder: `${this.workerId}:${job.id}`,
      ...(carrierMeter && carrierCard
        ? {
            carrierUsage: {
              meterKey: carrierMeter,
              provider: carrierProvider,
              priceCard: { id: carrierCard.id, version: carrierCard.version },
              ...(carrierCard.fxId
                ? { fx: { id: carrierCard.fxId, version: carrierCard.fxVersion! } }
                : {}),
            },
          }
        : {}),
      callId: text(payload.callId) ?? job.id,
      attemptId: text(payload.attemptId),
      sessionStartedAt: new Date().toISOString(),
      requiredMeterKeys,
      inference:
        inferenceRecord && typeof inferenceModel === 'string'
          ? { provider: inferenceRecord.provider, modelId: inferenceModel }
          : undefined,
      requestTermination: (reason) => this.terminate(job, reason),
    });
    const result = await attachment.reserveBeforeAdmission();
    if (!result.admitted)
      return {
        ...noCostAdmission(),
        admitted: false,
        reason: result.reason ?? 'cost-budget-blocked',
      };
    const session: HeldSession = {
      attachment,
      carrierMeter,
      carrierProvider,
      reservationId: sessionId,
      holder: `${this.workerId}:${job.id}`,
      maxCallSeconds: policy.maxCallSeconds,
      job,
    };
    this.sessions.set(job.id, session);
    this.startHeartbeat();
    return {
      admitted: true,
      beginActiveCall: () => {
        if (session.startedAt) return;
        session.startedAt = Date.now();
        attachment.beginActiveCall();
      },
      releaseBeforeStart: async () => {
        this.sessions.delete(job.id);
        this.stopHeartbeatIfIdle();
        return attachment.releaseBeforeStart();
      },
    };
  }

  usageForJob(jobId: string): ProviderUsageSink | undefined {
    return this.sessions.get(jobId)?.attachment.providerUsage;
  }

  inferenceUsageForJob(jobId: string): WorkerCostPolicyAttachment['inferenceUsage'] | undefined {
    return this.sessions.get(jobId)?.attachment.inferenceUsage;
  }

  async finalize(jobId: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) return;
    this.sessions.delete(jobId);
    this.stopHeartbeatIfIdle();
    if (session.startedAt && session.carrierMeter)
      session.attachment.recordElapsed({
        meterKey: session.carrierMeter,
        sourceKind: 'carrier',
        provider: session.carrierProvider,
        elapsedMs: Math.max(1, Date.now() - session.startedAt),
        eventId: `carrier-total:${jobId}`,
        occurredAt: new Date().toISOString(),
      });
    await session.attachment.finalizeKnownUsage();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.extendHeldReservations();
    }, 60_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeatIfIdle(): void {
    if (this.sessions.size || !this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async extendHeldReservations(): Promise<void> {
    await extendHeldCostReservations(this.ledger, [...this.sessions.values()], (job, reason) =>
      this.terminate(job, reason),
    );
  }

  private async terminate(job: DurableJob, reason: string): Promise<void> {
    if (this.terminationHandler) return this.terminationHandler(job, reason);
    const requested = await this.orchestration.requestSessionTermination(
      job.id,
      this.workerId,
      job.ownerEpoch ?? 0,
      reason,
    );
    if (!requested) return;
    const route = await this.orchestration.getSessionRoute(job.id);
    if (route?.carrierCallId) await this.telephony.hangup(route.carrierCallId);
  }

  private releaseSelections(release: ReleaseRecord): ReleaseSelections | undefined {
    return selectedReleaseSelections(release, this.registry, this.defaults);
  }
}

function noCostAdmission(): CostAdmission {
  return {
    admitted: true,
    beginActiveCall: () => undefined,
    releaseBeforeStart: async () => undefined,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
