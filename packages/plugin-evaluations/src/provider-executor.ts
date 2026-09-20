import type { Inference, InferenceReply, InferenceRequest } from '@winsendotai/ovo-contracts';
import {
  normalizeInferenceEvidence,
  type CostLedgerService,
  type InferenceEvidenceState,
  type InferenceUsageEvidence,
} from '@winsendotai/ovo-plugin-ledger';
import { executeEvaluationCase } from './executor.ts';
import { providerEvaluationPolicy, providerEvaluationReservationId } from './provider-policy.ts';
import type { EvaluationExecutor } from './service.ts';
import type {
  EvaluationCase,
  EvaluationCaseProvenance,
  EvaluationCaseResult,
  EvaluationRun,
  ReleaseEvaluationSnapshot,
} from './types.ts';

export interface ProviderEvaluationInferenceFactory {
  create(input: {
    release: ReleaseEvaluationSnapshot;
    bindingVersion: string;
    provider: string;
    modelId: string;
    maxOutputTokens: number;
    signal: AbortSignal;
    onUsage(evidence: InferenceUsageEvidence): Promise<void>;
  }): Promise<Inference>;
}

export interface ProviderEvaluationExecutorOptions {
  ledger: CostLedgerService;
  inference: ProviderEvaluationInferenceFactory;
  maxCaseDurationMs?: number;
  maxProviderRequestsPerCase?: number;
  maxOutputTokens?: number;
}

interface RunState {
  blocked?: string;
  unknownUsage: boolean;
  seenRequests: Map<string, string>;
}

interface CaseEvidence {
  requestIds: string[];
  state?: InferenceEvidenceState;
  reasons: Set<string>;
}

export class ProviderEvaluationExecutor implements EvaluationExecutor {
  readonly kind = 'provider' as const;
  private readonly states = new Map<string, RunState>();
  private readonly finalized = new Map<string, 'held' | 'settled'>();
  private readonly maxCaseDurationMs: number;
  private readonly maxProviderRequestsPerCase: number;
  private readonly maxOutputTokens: number;

  constructor(private readonly options: ProviderEvaluationExecutorOptions) {
    this.maxCaseDurationMs = bounded(options.maxCaseDurationMs ?? 30_000, 10, 120_000);
    this.maxProviderRequestsPerCase = bounded(options.maxProviderRequestsPerCase ?? 8, 1, 20);
    this.maxOutputTokens = bounded(options.maxOutputTokens ?? 1_024, 1, 8_192);
  }

  async executeCase(
    run: EvaluationRun,
    release: ReleaseEvaluationSnapshot,
    testCase: EvaluationCase,
    signal?: AbortSignal,
  ): Promise<Omit<EvaluationCaseResult, 'runId' | 'workspaceId' | 'createdAt'>> {
    const policy = providerEvaluationPolicy(release, run.fixtureBindingVersion, run.workspaceId);
    const state = this.state(run.id);
    const evidence: CaseEvidence = { requestIds: [], reasons: new Set() };
    await this.refreshBudget(run, policy.reservationPaise, state);
    const deadline = withDeadline(signal, this.maxCaseDurationMs);
    try {
      if (state.blocked) {
        evidence.reasons.add(state.blocked);
        if (state.unknownUsage) evidence.state = 'unknown';
      }
      const inference = state.blocked
        ? blockedInference(state.blocked)
        : await abortable(
            this.options.inference.create({
              release,
              bindingVersion: policy.bindingVersion,
              provider: policy.provider,
              modelId: policy.modelId,
              maxOutputTokens: this.maxOutputTokens,
              signal: deadline.signal,
              onUsage: async (usage) => {
                await this.recordUsage(run, policy, state, evidence, usage);
              },
            }),
            deadline.signal,
          );
      const metered = new BoundedInference(
        inference,
        state,
        evidence,
        this.maxProviderRequestsPerCase,
      );
      const result = await executeEvaluationCase(run, release, testCase, metered, deadline.signal);
      return { ...result, provenance: provenance(policy, evidence) };
    } finally {
      deadline.close();
    }
  }

  async finalizeRun(run: EvaluationRun): Promise<void> {
    if (this.finalized.has(run.id)) return;
    const state = this.states.get(run.id);
    if (state?.unknownUsage) {
      this.states.delete(run.id);
      remember(this.finalized, run.id, 'held');
      return;
    }
    const cost = await this.options.ledger.getSessionCost(run.workspaceId, run.id);
    await this.options.ledger.settleReservation(reservationId(run), cost.totalPaise);
    this.states.delete(run.id);
    remember(this.finalized, run.id, 'settled');
  }

  private state(runId: string): RunState {
    const current = this.states.get(runId);
    if (current) return current;
    const created: RunState = { unknownUsage: false, seenRequests: new Map() };
    this.states.set(runId, created);
    return created;
  }

  private async refreshBudget(run: EvaluationRun, limitPaise: string, state: RunState) {
    if (state.blocked) return;
    const cost = await this.options.ledger.getSessionCost(run.workspaceId, run.id);
    if (BigInt(cost.totalPaise) >= BigInt(limitPaise))
      state.blocked = 'evaluation-budget-exhausted';
  }

  private async recordUsage(
    run: EvaluationRun,
    policy: ReturnType<typeof providerEvaluationPolicy>,
    state: RunState,
    evidence: CaseEvidence,
    usageEvidence: InferenceUsageEvidence,
  ): Promise<void> {
    const normalized = normalizeInferenceEvidence(
      { provider: policy.provider, modelId: policy.modelId },
      usageEvidence,
      new Set(policy.priceCards.keys()),
      new Date().toISOString(),
    );
    const requestId = usageEvidence.requestId;
    if (requestId && requestId.length > 512)
      return this.blockUnknown(state, evidence, 'provider-request-id-invalid');
    if (requestId) {
      const previous = state.seenRequests.get(requestId);
      if (previous && previous !== normalized.fingerprint)
        return this.blockUnknown(state, evidence, 'provider-request-id-collision');
      if (previous) return;
      state.seenRequests.set(requestId, normalized.fingerprint);
      evidence.requestIds.push(requestId);
    }
    evidence.state = mergeEvidence(evidence.state, normalized.state);
    normalized.reasons.forEach((reason) => evidence.reasons.add(reason));
    if (normalized.state === 'unknown')
      return this.blockUnknown(state, evidence, normalized.reasons.join(',') || 'usage-unknown');
    try {
      for (const item of normalized.usage) {
        const card = policy.priceCards.get(item.meterKey);
        if (!card) return this.blockUnknown(state, evidence, `meter-unconfigured:${item.meterKey}`);
        await this.options.ledger.recordUsage({
          idempotencyKey: `evaluation:${run.id}:${item.providerRequestId}:${item.unit}`,
          workspaceId: run.workspaceId,
          sessionId: run.id,
          attemptId: String(run.attempt),
          provider: item.provider,
          providerRequestId: item.providerRequestId,
          sourceKind: item.sourceKind,
          sourceEventType: item.sourceEventType,
          sourceEventId: item.sourceEventId,
          activity: item.activity,
          cacheDisposition: item.cacheDisposition,
          quantity: item.quantity,
          unit: item.unit,
          occurredAt: item.occurredAt,
          priceCard: { id: card.id, version: card.version },
          fx: card.fxId && card.fxVersion ? { id: card.fxId, version: card.fxVersion } : undefined,
        });
      }
    } catch (error) {
      this.blockUnknown(state, evidence, 'ledger-usage-write-failed');
      throw error;
    }
    await this.refreshBudget(run, policy.reservationPaise, state);
    if (state.blocked) evidence.reasons.add(state.blocked);
  }

  private blockUnknown(state: RunState, evidence: CaseEvidence, reason: string): never {
    state.unknownUsage = true;
    state.blocked = reason;
    evidence.state = 'unknown';
    evidence.reasons.add(reason);
    throw new Error(`Provider evaluation stopped: ${reason}`);
  }
}

class BoundedInference implements Inference {
  private requests = 0;

  constructor(
    private readonly inner: Inference,
    private readonly state: RunState,
    private readonly evidence: CaseEvidence,
    private readonly maximum: number,
  ) {}

  async generate(request: InferenceRequest): Promise<InferenceReply> {
    if (this.state.blocked) throw new Error(`Provider evaluation stopped: ${this.state.blocked}`);
    if (this.requests >= this.maximum) throw new Error('Provider evaluation request limit reached');
    this.requests += 1;
    const evidenceCount = this.evidence.requestIds.length;
    try {
      const reply = await this.inner.generate(request);
      if (this.evidence.requestIds.length === evidenceCount)
        this.markUnknown('provider-request-usage-unavailable');
      return reply;
    } catch (error) {
      if (this.evidence.requestIds.length === evidenceCount && !this.state.unknownUsage)
        this.markUnknown('provider-request-outcome-unknown');
      throw error;
    }
  }

  private markUnknown(reason: string): never {
    this.state.unknownUsage = true;
    this.state.blocked = reason;
    this.evidence.state = 'unknown';
    this.evidence.reasons.add(reason);
    throw new Error(`Provider evaluation stopped: ${reason}`);
  }
}

function provenance(
  policy: ReturnType<typeof providerEvaluationPolicy>,
  evidence: CaseEvidence,
): EvaluationCaseProvenance {
  return {
    executor: 'provider',
    bindingVersion: policy.bindingVersion,
    provider: policy.provider,
    modelId: policy.modelId,
    providerRequestIds: evidence.requestIds,
    usageEvidence: evidence.state,
    usageReasons: [...evidence.reasons].sort(),
  };
}

function reservationId(run: EvaluationRun): string {
  return providerEvaluationReservationId({
    workspaceId: run.workspaceId,
    idempotencyKey: run.idempotencyKey,
  });
}

function mergeEvidence(
  current: InferenceEvidenceState | undefined,
  next: InferenceEvidenceState,
): InferenceEvidenceState {
  if (current === 'unknown' || next === 'unknown') return 'unknown';
  if (current === 'estimated' || next === 'estimated') return 'estimated';
  return 'reported';
}

function withDeadline(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Evaluation case deadline exceeded', 'TimeoutError')),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`Expected an integer between ${minimum} and ${maximum}`);
  return value;
}

function blockedInference(reason: string): Inference {
  return {
    async generate() {
      throw new Error(`Provider evaluation stopped: ${reason}`);
    },
  };
}

function remember(
  values: Map<string, 'held' | 'settled'>,
  runId: string,
  state: 'held' | 'settled',
) {
  values.set(runId, state);
  if (values.size > 1_024) values.delete(values.keys().next().value!);
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
