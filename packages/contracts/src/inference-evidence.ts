export interface InferenceUsageEvidence {
  requestId?: string;
  modelId?: string;
  usage: Record<string, number>;
}

export interface InferenceCostBinding {
  provider: string;
  modelId: string;
}

export interface InferenceEvidenceSummary {
  reportedSteps: number;
  estimatedSteps: number;
  unknownSteps: number;
  reasons: string[];
}

export type InferenceEvidenceState = 'reported' | 'estimated' | 'unknown';

export interface InferenceNormalizedUsage {
  meterKey: string;
  provider: string;
  providerRequestId: string;
  sourceKind: 'llm';
  sourceEventType: string;
  sourceEventId: string;
  activity: 'normal';
  cacheDisposition: 'none' | 'generation' | 'hit';
  quantity: string;
  unit: InferenceMeterUnit;
  occurredAt: string;
}

export interface NormalizedInferenceEvidence {
  fingerprint: string;
  state: InferenceEvidenceState;
  reasons: string[];
  usage: InferenceNormalizedUsage[];
}

export type InferenceMeterUnit =
  | 'input_tokens'
  | 'uncached_input_tokens'
  | 'cache_read_input_tokens'
  | 'cache_write_input_tokens'
  | 'output_tokens';

const COUNTERS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'uncachedInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'textOutputTokens',
  'reasoningOutputTokens',
] as const;

type Counter = (typeof COUNTERS)[number];

export function inferenceMeterKey(provider: string, unit: InferenceMeterUnit): string {
  return `${provider}.inference.${unit}`;
}

export function normalizeInferenceEvidence(
  binding: InferenceCostBinding,
  evidence: InferenceUsageEvidence,
  configuredMeters: ReadonlySet<string>,
  occurredAt: string,
): NormalizedInferenceEvidence {
  const fingerprint = inferenceEvidenceFingerprint(evidence);
  if (!evidence.requestId) return unknown(fingerprint, 'missing-request-id');
  if (!evidence.modelId) return unknown(fingerprint, 'missing-model-id');
  if (evidence.modelId !== binding.modelId) return unknown(fingerprint, 'model-id-mismatch');

  const counters = readCounters(evidence.usage);
  if (!counters) return unknown(fingerprint, 'invalid-token-counter');
  if (
    counters.totalTokens !== undefined &&
    counters.inputTokens !== undefined &&
    counters.outputTokens !== undefined &&
    counters.totalTokens !== counters.inputTokens + counters.outputTokens
  )
    return unknown(fingerprint, 'aggregate-total-inconsistent');

  const usage: InferenceNormalizedUsage[] = [];
  const reasons: string[] = [];
  let state: InferenceEvidenceState = 'reported';
  const add = (
    unit: InferenceMeterUnit,
    quantity: number,
    cacheDisposition: InferenceNormalizedUsage['cacheDisposition'],
    sourceEventType = 'provider.inference.reported',
  ) => {
    if (!quantity) return;
    usage.push({
      meterKey: inferenceMeterKey(binding.provider, unit),
      provider: binding.provider,
      providerRequestId: evidence.requestId!,
      sourceKind: 'llm',
      sourceEventType,
      sourceEventId: evidence.requestId!,
      activity: 'normal',
      cacheDisposition,
      quantity: String(quantity),
      unit,
      occurredAt,
    });
  };

  const details = [
    counters.uncachedInputTokens,
    counters.cacheReadInputTokens,
    counters.cacheWriteInputTokens,
  ];
  const completeInputDetails = details.every((value) => value !== undefined);
  const consistentInputDetails =
    counters.inputTokens !== undefined &&
    completeInputDetails &&
    details.reduce<number>((sum, value) => sum + value!, 0) === counters.inputTokens;
  const detailedInputMeters = [
    'uncached_input_tokens',
    'cache_read_input_tokens',
    'cache_write_input_tokens',
  ] as const;
  const detailedInputConfigured = detailedInputMeters.every((unit) =>
    configuredMeters.has(inferenceMeterKey(binding.provider, unit)),
  );
  const fallbackMeter = inferenceMeterKey(binding.provider, 'input_tokens');

  if (consistentInputDetails && detailedInputConfigured) {
    add('uncached_input_tokens', counters.uncachedInputTokens!, 'none');
    add('cache_read_input_tokens', counters.cacheReadInputTokens!, 'hit');
    add('cache_write_input_tokens', counters.cacheWriteInputTokens!, 'generation');
  } else if (counters.inputTokens !== undefined && configuredMeters.has(fallbackMeter)) {
    state = 'estimated';
    reasons.push(
      consistentInputDetails
        ? 'input-policy-aggregate-fallback'
        : completeInputDetails
          ? 'input-breakdown-inconsistent-fallback'
          : 'input-breakdown-incomplete-fallback',
    );
    add('input_tokens', counters.inputTokens, 'none', 'provider.inference.estimated-input');
  } else if (counters.inputTokens !== undefined) {
    if (consistentInputDetails) {
      state = 'unknown';
      reasons.push('input-detail-meter-unconfigured');
    } else {
      state = 'unknown';
      reasons.push(
        completeInputDetails ? 'input-breakdown-inconsistent' : 'input-breakdown-incomplete',
      );
    }
  } else {
    state = 'unknown';
    reasons.push('input-total-missing');
  }

  if (counters.outputTokens === undefined) {
    state = 'unknown';
    reasons.push('output-total-missing');
  } else if (!outputDetailsAreConsistent(counters)) {
    state = 'unknown';
    reasons.push('output-breakdown-inconsistent');
  } else {
    add('output_tokens', counters.outputTokens, 'none');
  }

  return { fingerprint, state, reasons, usage };
}

export function emptyInferenceEvidenceSummary(): InferenceEvidenceSummary {
  return { reportedSteps: 0, estimatedSteps: 0, unknownSteps: 0, reasons: [] };
}

function readCounters(usage: Record<string, number>): Partial<Record<Counter, number>> | undefined {
  const counters: Partial<Record<Counter, number>> = {};
  for (const name of COUNTERS) {
    if (!Object.hasOwn(usage, name)) continue;
    const value = usage[name];
    if (!Number.isSafeInteger(value) || value! < 0) return undefined;
    counters[name] = value;
  }
  return counters;
}

function outputDetailsAreConsistent(counters: Partial<Record<Counter, number>>): boolean {
  const output = counters.outputTokens!;
  const text = counters.textOutputTokens;
  const reasoning = counters.reasoningOutputTokens;
  if (text !== undefined && text > output) return false;
  if (reasoning !== undefined && reasoning > output) return false;
  return text === undefined || reasoning === undefined || text + reasoning <= output;
}

function unknown(fingerprint: string, reason: string): NormalizedInferenceEvidence {
  return { fingerprint, state: 'unknown', reasons: [reason], usage: [] };
}

function inferenceEvidenceFingerprint(evidence: InferenceUsageEvidence): string {
  const usage = Object.fromEntries(
    COUNTERS.filter((name) => Object.hasOwn(evidence.usage, name)).map((name) => [
      name,
      evidence.usage[name],
    ]),
  );
  return JSON.stringify({ requestId: evidence.requestId, modelId: evidence.modelId, usage });
}
