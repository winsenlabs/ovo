import type { ProviderUsage } from './cost-policy-types.ts';
import type { ReservationResult } from '@winsendotai/ovo-plugin-ledger';
import { WorkerCostPolicyCore } from './cost-policy-core.ts';
import { normalizeInferenceEvidence, type InferenceUsageEvidence } from './cost-inference.ts';
import {
  millisecondsToSeconds,
  providerMeterKey,
  providerSourceKind,
} from './cost-policy-support.ts';
import type {
  CacheGenerationUsageInput,
  CostPolicy,
  CostPolicyFinalization,
  CostTerminationReason,
  ElapsedUsageInput,
  WorkerCostPolicyAttachment,
  WorkerCostPolicyOptions,
} from './cost-policy-types.ts';

export type {
  InferenceCostBinding,
  InferenceEvidenceSummary,
  InferenceMeterUnit,
  InferenceUsageEvidence,
} from './cost-inference.ts';
export { inferenceMeterKey } from './cost-inference.ts';
export type {
  CacheGenerationUsageInput,
  CostPolicy,
  CostPolicyFinalization,
  CostTerminationReason,
  ElapsedUsageInput,
  WorkerCostPolicyAttachment,
  WorkerCostPolicyOptions,
} from './cost-policy-types.ts';
export { providerMeterKey } from './cost-policy-support.ts';

export class WorkerCostPolicyController extends WorkerCostPolicyCore {
  reserveBeforeAdmission(): Promise<ReservationResult> {
    return (this.admission ??= this.reserve());
  }

  beginActiveCall(): void {
    if (!this.admitted || this.terminal) throw new Error('Cost reservation is not active');
    if (this.started) return;
    this.started = true;
    this.timer = this.timers.set(this.policy.maxCallSeconds * 1_000, () => {
      this.requestTermination('cost-max-duration');
    });
  }

  observeProviderUsage(usage: ProviderUsage): boolean {
    const meterKey = providerMeterKey(usage);
    if (this.closing || this.terminal) {
      this.missingMeters.add(`${meterKey}:after-meter-close`);
      return false;
    }
    if (usage.state === 'unavailable') {
      this.missingMeters.add(meterKey);
      return true;
    }
    if (!usage.requestId) {
      this.missingMeters.add(`${meterKey}:missing-request-id`);
      this.requestTermination('cost-provider-usage-unidentified');
      return false;
    }
    const sourceKind = providerSourceKind(usage.operation);
    return this.enqueueUsage({
      meterKey,
      provider: usage.provider,
      providerRequestId: usage.requestId,
      sourceKind,
      sourceEventType: `provider.${usage.operation}.${usage.state}`,
      sourceEventId: usage.requestId,
      activity: 'normal',
      cacheDisposition: sourceKind === 'tts-generation' ? 'generation' : 'none',
      quantity: usage.quantity,
      unit: usage.unit,
      occurredAt: this.options.sessionStartedAt,
    });
  }

  observeInferenceUsage(evidence: InferenceUsageEvidence): boolean {
    if (this.closing || this.terminal) {
      this.recordInferenceEvidence('unknown', ['after-meter-close']);
      return false;
    }
    if (!this.admitted) return false;
    const binding = this.options.inference;
    if (!binding) {
      this.recordInferenceEvidence('unknown', ['binding-unconfigured']);
      this.requestTermination('cost-provider-usage-unidentified');
      return false;
    }
    const normalized = normalizeInferenceEvidence(
      binding,
      evidence,
      new Set(this.cards.keys()),
      this.options.sessionStartedAt,
    );
    if (evidence.requestId) {
      const previous = this.seenInferenceRequests.get(evidence.requestId);
      if (previous === normalized.fingerprint) return true;
      if (previous) {
        this.recordInferenceEvidence('unknown', ['request-id-collision']);
        this.requestTermination('cost-provider-usage-unidentified');
        return false;
      }
    }
    if (!evidence.requestId || !evidence.modelId || evidence.modelId !== binding.modelId) {
      this.recordInferenceEvidence(normalized.state, normalized.reasons);
      for (const reason of normalized.reasons)
        this.missingMeters.add(`${binding.provider}.inference:${reason}`);
      this.requestTermination('cost-provider-usage-unidentified');
      return false;
    }
    if (!this.enqueueUsageSet(normalized.usage)) return false;
    this.seenInferenceRequests.set(evidence.requestId, normalized.fingerprint);
    this.recordInferenceEvidence(normalized.state, normalized.reasons);
    if (normalized.state === 'unknown') {
      for (const reason of normalized.reasons)
        this.missingMeters.add(`${binding.provider}.inference:${reason}`);
      this.requestTermination('cost-provider-usage-unidentified');
    }
    return true;
  }

  recordElapsed(input: ElapsedUsageInput): boolean {
    if (!Number.isSafeInteger(input.elapsedMs) || input.elapsedMs <= 0)
      throw new TypeError('elapsedMs must be a positive safe integer');
    return this.enqueueUsage({
      meterKey: input.meterKey,
      provider: input.provider,
      sourceKind: input.sourceKind,
      sourceEventType: `${input.sourceKind}.elapsed.estimated`,
      sourceEventId: input.eventId,
      activity: input.activity ?? 'normal',
      cacheDisposition: 'none',
      quantity: millisecondsToSeconds(input.elapsedMs),
      unit: 'audio_seconds',
      occurredAt: input.occurredAt,
    });
  }

  recordCacheGeneration(input: CacheGenerationUsageInput): boolean {
    if (input.cacheDisposition === 'hit') return true;
    return this.enqueueUsage({
      ...input,
      sourceKind: 'tts-generation',
      sourceEventType: 'tts.cache-generation',
      sourceEventId: input.eventId,
      activity: 'normal',
      occurredAt: input.occurredAt,
    });
  }

  async flushUsage(): Promise<void> {
    await this.tail;
    if (this.queueFailure) throw this.queueFailure;
  }

  async finalizeKnownUsage(): Promise<CostPolicyFinalization> {
    this.assertAdmitted();
    this.closing = true;
    this.stopTimer();
    await this.flushUsage();
    const cost = await this.options.ledger.getSessionCost(
      this.options.workspaceId,
      this.options.sessionId,
    );
    const reservation = await this.options.ledger.settleReservation(
      this.options.sessionId,
      cost.totalPaise,
    );
    this.terminal = true;
    return {
      reservation,
      cost,
      missingProviderMeters: [...this.missingMeters].sort(),
      inferenceUsageEvidence: {
        ...this.inferenceEvidence,
        reasons: [...this.inferenceEvidence.reasons],
      },
      billingComplete: false,
      lateBillingPossible: true,
      caveat:
        'Known usage is settled; omitted provider units and later provider invoices can still change incurred spend.',
    };
  }

  async releaseBeforeStart(): Promise<ReservationResult> {
    this.assertAdmitted();
    if (this.started || this.pending || this.missingMeters.size)
      throw new Error('A started or metered session must settle known usage, not release');
    this.closing = true;
    this.stopTimer();
    const released = await this.options.ledger.releaseReservation(this.options.sessionId);
    this.terminal = true;
    return released;
  }
}

export function createWorkerCostPolicyAttachment(
  options: WorkerCostPolicyOptions,
): WorkerCostPolicyAttachment {
  const controller = new WorkerCostPolicyController(options);
  return {
    controller,
    reserveBeforeAdmission: () => controller.reserveBeforeAdmission(),
    providerUsage: (usage) => {
      controller.observeProviderUsage(usage);
    },
    inferenceUsage: (evidence) => {
      controller.observeInferenceUsage(evidence);
    },
    beginActiveCall: () => controller.beginActiveCall(),
    recordElapsed: (input) => controller.recordElapsed(input),
    recordCacheGeneration: (input) => controller.recordCacheGeneration(input),
    finalizeKnownUsage: () => controller.finalizeKnownUsage(),
    releaseBeforeStart: () => controller.releaseBeforeStart(),
  };
}
