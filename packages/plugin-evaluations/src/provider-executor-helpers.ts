import type {
  Inference,
  InferenceEvidenceState,
  InferenceReply,
  InferenceRequest,
} from '@winsendotai/ovo-contracts';
import { providerEvaluationPolicy, providerEvaluationReservationId } from './provider-policy.ts';
import type { EvaluationCaseProvenance, EvaluationRun } from './types.ts';

export interface RunState {
  blocked?: string;
  unknownUsage: boolean;
  seenRequests: Map<string, string>;
}

export interface CaseEvidence {
  requestIds: string[];
  state?: InferenceEvidenceState;
  reasons: Set<string>;
}

export class BoundedInference implements Inference {
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

export function provenance(
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

export function reservationId(run: EvaluationRun): string {
  return providerEvaluationReservationId({
    workspaceId: run.workspaceId,
    idempotencyKey: run.idempotencyKey,
  });
}

export function mergeEvidence(
  current: InferenceEvidenceState | undefined,
  next: InferenceEvidenceState,
): InferenceEvidenceState {
  if (current === 'unknown' || next === 'unknown') return 'unknown';
  if (current === 'estimated' || next === 'estimated') return 'estimated';
  return 'reported';
}

export function withDeadline(parent: AbortSignal | undefined, timeoutMs: number) {
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

export function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(`Expected an integer between ${minimum} and ${maximum}`);
  return value;
}

export function blockedInference(reason: string): Inference {
  return {
    async generate() {
      throw new Error(`Provider evaluation stopped: ${reason}`);
    },
  };
}

export function remember(
  values: Map<string, 'held' | 'settled'>,
  runId: string,
  state: 'held' | 'settled',
) {
  values.set(runId, state);
  if (values.size > 1_024) values.delete(values.keys().next().value!);
}

export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
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
