import { liveSessionRequiresInput } from './live-input-policy.ts';
import type {
  DurableJob,
  DurableJobStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import {
  openAiInferenceBindingFromRecord,
  type ProviderUsageSink,
} from '@winsendotai/ovo-plugin-providers';
import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import type { ControlStore, ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { definePlugin } from '@winsendotai/ovo-runtime';
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
): readonly string[] {
  const policy = release.config.costPolicy;
  if (!policy) return [];
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

export function createWorkerCostRuntimePlugin(input: {
  ledger: CostLedgerService;
  control: ControlStore;
}) {
  return definePlugin(
    {
      id: '@winsendotai/ovo-worker/cost-runtime',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: ['orchestration.store', 'telephony.control'],
      provides: [WORKER_COST_RUNTIME_SERVICE_KEY],
      configSchema: {
        type: 'object',
        required: ['workerId'],
        properties: {
          workerId: { type: 'string' },
          requirePolicy: { type: 'boolean', default: true },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    (ctx, config) => {
      if (typeof config.workerId !== 'string' || !config.workerId)
        throw new Error('Missing workerId');
      ctx.provide(
        WORKER_COST_RUNTIME_SERVICE_KEY,
        new ProductionWorkerCostRuntime(
          input.ledger,
          input.control,
          ctx.get('orchestration.store') as DurableJobStore,
          ctx.get('telephony.control') as TelephonyControl,
          config.workerId,
          config.requirePolicy !== false,
        ),
      );
    },
  );
}

export class ProductionWorkerCostRuntime implements WorkerCostRuntimePort {
  private readonly sessions = new Map<
    string,
    { attachment: WorkerCostPolicyAttachment; startedAt?: number; carrierMeter: string }
  >();

  constructor(
    private readonly ledger: CostLedgerService,
    private readonly control: ControlStore,
    private readonly orchestration: DurableJobStore,
    private readonly telephony: TelephonyControl,
    private readonly workerId: string,
    private readonly requirePolicy = true,
  ) {}

  async reserve(job: DurableJob, payload: Record<string, unknown>, sessionId: string) {
    const releaseId = text(payload.releaseId);
    if (!releaseId) return noCostAdmission();
    const release = await this.control.getRelease(job.workspaceId, releaseId);
    const policy = release?.config.costPolicy;
    if (!policy)
      return this.requirePolicy
        ? { ...noCostAdmission(), admitted: false, reason: 'release-cost-policy-required' }
        : noCostAdmission();
    const requiredMeterKeys = requiredLiveCostMeterKeys(release);
    const missingMeters = requiredMeterKeys.filter((meterKey) => !policy.priceCards[meterKey]);
    if (missingMeters.length)
      return {
        ...noCostAdmission(),
        admitted: false,
        reason: `cost-meter-unconfigured:${missingMeters.join(',')}`,
      };
    const inferenceRecord = release.providerBindings.inference;
    const inferenceBinding = inferenceRecord
      ? openAiInferenceBindingFromRecord(inferenceRecord)
      : undefined;
    const attachment = createWorkerCostPolicyAttachment({
      ledger: this.ledger,
      policy,
      workspaceId: job.workspaceId,
      sessionId,
      callId: text(payload.callId) ?? job.id,
      attemptId: text(payload.attemptId),
      sessionStartedAt: new Date().toISOString(),
      requiredMeterKeys,
      inference: inferenceBinding
        ? { provider: 'openai', modelId: inferenceBinding.model }
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
    } = {
      attachment,
      carrierMeter: LIVE_COST_METER_KEYS.carrier,
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
        provider: 'twilio',
        elapsedMs: Math.max(1, Date.now() - session.startedAt),
        eventId: `carrier-total:${jobId}`,
        occurredAt: new Date().toISOString(),
      });
    await session.attachment.finalizeKnownUsage();
  }

  private async terminate(job: DurableJob, reason: string): Promise<void> {
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
