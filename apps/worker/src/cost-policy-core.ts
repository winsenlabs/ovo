import type { PriceCardVersion, ReservationResult } from '@winsendotai/ovo-plugin-ledger';
import { emptyInferenceEvidenceSummary } from './cost-inference.ts';
import {
  accumulateInferenceEvidence,
  durableReservationFields,
  loadCostCatalog,
  usageIdentity,
  validatePolicy,
  type NormalizedUsage,
} from './cost-policy-support.ts';
import type {
  CostPolicy,
  CostTerminationReason,
  WorkerCostPolicyOptions,
} from './cost-policy-types.ts';

export class WorkerCostPolicyCore {
  protected readonly policy: CostPolicy;
  protected readonly maxPending: number;
  protected readonly timers: NonNullable<WorkerCostPolicyOptions['timers']>;
  protected cards = new Map<string, PriceCardVersion>();
  protected readonly missingMeters = new Set<string>();
  protected readonly seenEvents = new Set<string>();
  protected readonly seenInferenceRequests = new Map<string, string>();
  protected readonly inferenceEvidence = emptyInferenceEvidenceSummary();
  protected tail: Promise<void> = Promise.resolve();
  protected admission?: Promise<ReservationResult>;
  protected admitted = false;
  protected started = false;
  protected closing = false;
  protected terminal = false;
  protected pending = 0;
  protected timer?: unknown;
  protected queueFailure?: unknown;
  protected terminationRequested = false;

  constructor(protected readonly options: WorkerCostPolicyOptions) {
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

  protected async reserve(): Promise<ReservationResult> {
    const budget = await this.options.ledger.getBudget(this.policy.budgetId);
    if (!budget || budget.workspaceId !== this.options.workspaceId)
      throw new Error('Cost budget is unavailable for this workspace');
    await this.loadCatalog();
    const result = await this.options.ledger.reserveBudget({
      budgetId: this.policy.budgetId,
      reservationId: this.options.sessionId,
      amountPaise: this.policy.reservationPaise,
      sourceRef: `session:${this.options.sessionId}`,
      ...durableReservationFields(this.options, this.policy.maxCallSeconds),
    });
    this.admitted = result.admitted;
    return result;
  }

  protected async loadCatalog(): Promise<void> {
    this.cards = await loadCostCatalog(
      this.options.ledger,
      this.policy,
      this.options.requiredMeterKeys ?? [],
      this.options.prefetchedPriceCards,
    );
  }

  protected enqueueUsage(input: NormalizedUsage): boolean {
    return this.enqueueUsageSet([input]);
  }

  protected enqueueUsageSet(inputs: readonly NormalizedUsage[]): boolean {
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

  protected async writeUsage(input: NormalizedUsage): Promise<void> {
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

  protected requestTermination(reason: CostTerminationReason): void {
    if (this.terminationRequested) return;
    this.terminationRequested = true;
    void Promise.resolve(this.options.requestTermination(reason)).catch(() => undefined);
  }

  protected stopTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  protected assertAdmitted(): void {
    if (!this.admitted || this.terminal) throw new Error('Cost reservation is not active');
  }

  protected recordInferenceEvidence(
    state: 'reported' | 'estimated' | 'unknown',
    reasons: readonly string[],
  ): void {
    accumulateInferenceEvidence(this.inferenceEvidence, state, reasons);
  }
}
