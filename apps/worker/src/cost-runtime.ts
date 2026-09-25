import { liveSessionRequiresInput } from './live-input-policy.ts';
import type {
  DurableJob,
  DurableJobStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ProviderUsageSink } from './cost-policy-types.ts';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import {
  deriveLegacySelections,
  type ControlStore,
  type ReleaseRecord,
} from '@winsendotai/ovo-plugin-storage';
import { manifestKeys, PluginRegistry } from '@winsendotai/ovo-runtime';
import { metersFor, type SessionDefaults } from '@winsendotai/ovo-session-host';
import type { ReleaseSelections } from '@winsendotai/ovo-contracts';
import type { SelectedJobCarrier } from './carrier-runtime.ts';
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

export const LIVE_COST_METER_KEYS = Object.freeze({
  carrier: 'twilio.carrier.audio_seconds',
  tts: 'openai.streaming-tts.characters',
  stt: 'deepgram.streaming-stt.audio_seconds',
  inference: Object.freeze({
    aggregateInput: 'openai.inference.input_tokens',
    uncachedInput: 'openai.inference.uncached_input_tokens',
    cacheReadInput: 'openai.inference.cache_read_input_tokens',
    cacheWriteInput: 'openai.inference.cache_write_input_tokens',
    output: 'openai.inference.output_tokens',
  }),
});

export function requiredLiveCostMeterKeys(
  release: Pick<ReleaseRecord, 'config'>,
  selected?: { selections: ReleaseSelections; registry: PluginRegistry },
): readonly string[] {
  const policy = release.config.costPolicy;
  if (!policy) return [];
  if (selected)
    return metersFor(selected.selections, selected.registry, {
      requiresInput: liveSessionRequiresInput(release.config),
    }).map((row) => row.meter.key);
  const required: string[] = [LIVE_COST_METER_KEYS.carrier, LIVE_COST_METER_KEYS.tts];
  const requiresInput = liveSessionRequiresInput(release.config);
  if (requiresInput) required.push(LIVE_COST_METER_KEYS.stt);
  if (release.config.mode === 'context' || release.config.mode === 'agent') {
    const detailedInput = [
      LIVE_COST_METER_KEYS.inference.uncachedInput,
      LIVE_COST_METER_KEYS.inference.cacheReadInput,
      LIVE_COST_METER_KEYS.inference.cacheWriteInput,
    ];
    required.push(
      ...(detailedInput.every((meterKey) => policy.priceCards[meterKey])
        ? detailedInput
        : policy.priceCards[LIVE_COST_METER_KEYS.inference.aggregateInput]
          ? [LIVE_COST_METER_KEYS.inference.aggregateInput]
          : detailedInput),
      LIVE_COST_METER_KEYS.inference.output,
    );
  }
  return required;
}

export class ProductionWorkerCostRuntime implements WorkerCostRuntimePort {
  private terminationHandler?: (job: DurableJob, reason: string) => Promise<void>;
  private readonly sessions = new Map<
    string,
    {
      attachment: WorkerCostPolicyAttachment;
      startedAt?: number;
      carrierMeter: string;
      carrierProvider: string;
    }
  >();

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
    const releaseId = text(payload.releaseId);
    if (!releaseId) return noCostAdmission();
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
    const carrierProvider =
      carrier && this.registry
        ? (manifestKeys(this.registry.get(carrier.pluginId)!.manifest).manifest.provider ??
          'carrier')
        : 'twilio';
    const attachment = createWorkerCostPolicyAttachment({
      ledger: this.ledger,
      policy,
      workspaceId: job.workspaceId,
      sessionId,
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
    const session: {
      attachment: WorkerCostPolicyAttachment;
      startedAt?: number;
      carrierMeter: string;
      carrierProvider: string;
    } = {
      attachment,
      carrierMeter: carrier?.meter.key ?? LIVE_COST_METER_KEYS.carrier,
      carrierProvider,
    };
    this.sessions.set(job.id, session);
    return {
      admitted: true,
      beginActiveCall: () => {
        if (session.startedAt) return;
        session.startedAt = Date.now();
        attachment.beginActiveCall();
      },
      releaseBeforeStart: async () => {
        this.sessions.delete(job.id);
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
    if (session.startedAt)
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
    if (Object.keys(release.selections ?? {}).length)
      return release.selections as ReleaseSelections;
    if (!this.registry) return undefined;
    const legacy = deriveLegacySelections(release, this.registry, {
      engine: this.defaults?.engine ?? '@winsendotai/ovo-plugin-voice-session-engine',
      ...(this.defaults?.turnDetector ? { turnDetector: this.defaults.turnDetector } : {}),
    });
    return Object.fromEntries(
      Object.entries(legacy).map(([slot, selection]) => [
        slot,
        {
          ...selection,
          version: this.registry!.get(selection.pluginId)!.manifest.version,
        },
      ]),
    ) as ReleaseSelections;
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
