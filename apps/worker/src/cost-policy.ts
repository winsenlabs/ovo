import type { ProviderUsage } from '@winsendotai/ovo-plugin-providers';
import type { PriceCardVersion, ReservationResult } from '@winsendotai/ovo-plugin-ledger';
import {
  emptyInferenceEvidenceSummary,
  normalizeInferenceEvidence,
  type InferenceUsageEvidence,
} from './cost-inference.ts';
import {
  loadCostCatalog,
  millisecondsToSeconds,
  providerMeterKey,
  providerSourceKind,
  usageIdentity,
  validatePolicy,
  type NormalizedUsage,
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

export class WorkerCostPolicyController {
  private readonly policy: CostPolicy;
  private readonly maxPending: number;
  private readonly timers: NonNullable<WorkerCostPolicyOptions['timers']>;
  private cards = new Map<string, PriceCardVersion>();
  private readonly missingMeters = new Set<string>();
  private readonly seenEvents = new Set<string>();
  private readonly seenInferenceRequests = new Map<string, string>();
  private readonly inferenceEvidence = emptyInferenceEvidenceSummary();
  private tail: Promise<void> = Promise.resolve();
  private admission?: Promise<ReservationResult>;
  private admitted = false;
  private started = false;
  private closing = false;
  private terminal = false;
  private pending = 0;
  private timer?: unknown;
  private queueFailure?: unknown;
  private terminationRequested = false;

  constructor(private readonly options: WorkerCostPolicyOptions) {
    this.policy = structuredClone(options.policy);
    this.maxPending = options.maxPendingUsage ?? 256;
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 10_000)
      throw new TypeError('maxPendingUsage must be an integer from 1 to 10000');
    this.timers =
      options.timers ??
      ({
        set: (delayMs, callback) => {
          const timer = setTimeout(callback, delayMs);
          timer.unref?.();
          return timer;
        },
        clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
      } satisfies NonNullable<WorkerCostPolicyOptions['timers']>);
    validatePolicy(this.policy);
    if (!Number.isFinite(Date.parse(options.sessionStartedAt)))
      throw new TypeError('sessionStartedAt must be an ISO timestamp');
  }

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

  private async reserve(): Promise<ReservationResult> {
    const budget = await this.options.ledger.getBudget(this.policy.budgetId);
    if (!budget || budget.workspaceId !== this.options.workspaceId)
      throw new Error('Cost budget is unavailable for this workspace');
    await this.loadCatalog();
    const result = await this.options.ledger.reserveBudget({
      budgetId: this.policy.budgetId,
      reservationId: this.options.sessionId,
      amountPaise: this.policy.reservationPaise,
      sourceRef: `session:${this.options.sessionId}`,
    });
    this.admitted = result.admitted;
    return result;
  }

  private async loadCatalog(): Promise<void> {
    this.cards = await loadCostCatalog(
      this.options.ledger,
      this.policy,
      this.options.requiredMeterKeys ?? [],
    );
  }

  private enqueueUsage(input: NormalizedUsage): boolean {
    return this.enqueueUsageSet([input]);
  }

  private enqueueUsageSet(inputs: readonly NormalizedUsage[]): boolean {
    if (!this.admitted || this.closing || this.terminal) return false;
    const missing = inputs.filter((input) => !this.cards.has(input.meterKey));
    if (missing.length) {
      for (const input of missing) this.missingMeters.add(input.meterKey);
      this.requestTermination('cost-meter-unconfigured');
      return false;
    }
    const fresh = inputs.filter(
      (input) => !this.seenEvents.has(usageIdentity(this.options.sessionId, input)),
    );
    if (this.pending + fresh.length > this.maxPending) {
      this.requestTermination('cost-usage-backpressure');
      return false;
    }
    for (const input of fresh) {
      this.seenEvents.add(usageIdentity(this.options.sessionId, input));
      this.pending += 1;
      const operation = this.tail.then(() => this.writeUsage(input));
      this.tail = operation
        .catch((error) => {
          this.queueFailure ??= error;
          this.requestTermination('cost-usage-write-failed');
        })
        .finally(() => {
          this.pending -= 1;
        });
    }
    return true;
  }

  private async writeUsage(input: NormalizedUsage): Promise<void> {
    const card = this.cards.get(input.meterKey)!;
    if (card.provider !== input.provider || card.unit !== input.unit)
      throw new TypeError(`Cost meter does not match provider native units: ${input.meterKey}`);
    const reference = this.policy.priceCards[input.meterKey]!;
    await this.options.ledger.recordUsage({
      idempotencyKey: usageIdentity(this.options.sessionId, input),
      workspaceId: this.options.workspaceId,
      sessionId: this.options.sessionId,
      callId: this.options.callId,
      attemptId: this.options.attemptId,
      provider: input.provider,
      providerRequestId: input.providerRequestId,
      sourceKind: input.sourceKind,
      sourceEventType: input.sourceEventType,
      sourceEventId: `${this.options.sessionId}:${input.sourceEventId}`,
      activity: input.activity,
      cacheDisposition: input.cacheDisposition,
      quantity: input.quantity,
      unit: input.unit,
      occurredAt: input.occurredAt,
      priceCard: { id: reference.id, version: reference.version },
      fx:
        reference.fxId && reference.fxVersion
          ? { id: reference.fxId, version: reference.fxVersion }
          : undefined,
    });
    const summary = await this.options.ledger.getSessionCost(
      this.options.workspaceId,
      this.options.sessionId,
    );
    if (BigInt(summary.totalPaise) >= BigInt(this.policy.reservationPaise))
      this.requestTermination('cost-spend-threshold');
  }

  private requestTermination(reason: CostTerminationReason): void {
    if (this.terminationRequested) return;
    this.terminationRequested = true;
    void Promise.resolve(this.options.requestTermination(reason)).catch(() => undefined);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private assertAdmitted(): void {
    if (!this.admitted || this.terminal) throw new Error('Cost reservation is not active');
  }

  private recordInferenceEvidence(
    state: 'reported' | 'estimated' | 'unknown',
    reasons: readonly string[],
  ): void {
    if (state === 'reported') this.inferenceEvidence.reportedSteps += 1;
    if (state === 'estimated') this.inferenceEvidence.estimatedSteps += 1;
    if (state === 'unknown') this.inferenceEvidence.unknownSteps += 1;
    this.inferenceEvidence.reasons = [
      ...new Set([...this.inferenceEvidence.reasons, ...reasons]),
    ].sort();
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
