import { timeoutOf } from '@winsendotai/ovo-contracts';
import { evidenceRecord } from '@winsendotai/ovo-plugin-observability';
import type { StoredCallEvent, UsageEntry } from '@winsendotai/ovo-plugin-storage';

/** Call events that record something going wrong, whatever else the call did. */
const FAILURE_TYPES = new Set([
  'session.failed',
  'fixture.error',
  'simulation.error',
  'outcome.write-failed',
  'speech.failed',
  'speech.dropped',
  'operation.failed',
]);
const MAX_ERRORS = 200;

export interface CallError {
  sequence: number;
  at: string;
  type: string;
  message: string;
  turnId?: string;
  stage?: string;
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

function failureOf(event: StoredCallEvent): CallError | undefined {
  const payload = event.payload;
  const base = { sequence: event.sequence, at: event.at, type: event.type };
  if (FAILURE_TYPES.has(event.type))
    return {
      ...base,
      message: text(payload.message) ?? text(payload.reason) ?? text(payload.error) ?? event.type,
      ...(text(payload.turnId) ? { turnId: text(payload.turnId) } : {}),
    };
  // A decision that timed out or failed is answered by the fallback; it is still an error to see.
  if (
    event.type === 'decision.made' &&
    (payload.outcome === 'failed' || payload.outcome === 'timeout')
  )
    return {
      ...base,
      message: `decision ${payload.outcome}${text(payload.reason) ? `: ${text(payload.reason)}` : ''}`,
      stage: 'decision',
      ...(text(payload.turnId) ? { turnId: text(payload.turnId) } : {}),
    };
  return undefined;
}

/**
 * What the inspector needs to say why a call ended and what went wrong (OBS-7): the end reason
 * with the stage that timed out (OBS-9), every failure event in order, the call's speculation and
 * guardrail summaries, and its evidence accounting (OBS-10: evidence the writer dropped).
 */
export function callDiagnosis(events: readonly StoredCallEvent[]) {
  let endReason: string | undefined;
  let speculation: Record<string, unknown> | undefined;
  let guardrail: Record<string, unknown> | undefined;
  let evidence: Record<string, unknown> | undefined;
  const errors: CallError[] = [];
  let errorCount = 0;
  for (const event of events) {
    if (event.type === 'session.ended' || event.type === 'session.failed')
      endReason = text(event.payload.reason) ?? endReason;
    else if (event.type === 'session.engine-ended' && !endReason)
      endReason = text(event.payload.reason);
    else if (event.type === 'speculation.summary') speculation = event.payload;
    else if (event.type === 'guardrail.summary') guardrail = event.payload;
    else if (event.type === 'telemetry.stats') evidence = event.payload;
    const failure = failureOf(event);
    if (failure && errorCount++ < MAX_ERRORS) errors.push(failure);
  }
  return {
    endReason: endReason ?? null,
    timeout: endReason ? (timeoutOf(endReason) ?? null) : null,
    errors,
    errorsTruncated: errorCount > errors.length,
    speculation: speculation ?? null,
    guardrail: guardrail ?? null,
    evidence: evidence ?? null,
  };
}

/** Cost per currency (INR, USD...): no line is hidden because it is not in rupees. */
export function costByCurrency(usage: readonly UsageEntry[]) {
  const totals = new Map<
    string,
    { estimatedMinor: bigint; reconciledMinor: bigint; lines: number }
  >();
  for (const line of usage) {
    const total = totals.get(line.currency) ?? {
      estimatedMinor: 0n,
      reconciledMinor: 0n,
      lines: 0,
    };
    let amount: bigint;
    try {
      amount = BigInt(line.amountMinor);
    } catch {
      continue;
    }
    if (line.state === 'reconciled') total.reconciledMinor += amount;
    else total.estimatedMinor += amount;
    total.lines += 1;
    totals.set(line.currency, total);
  }
  return [...totals].map(([currency, total]) => ({
    currency,
    estimatedMinor: total.estimatedMinor.toString(),
    reconciledMinor: total.reconciledMinor.toString(),
    lines: total.lines,
  }));
}

/** The plugins a fixture result says it ran, else the release's own selections. */
export function evidenceSelections(resolved: unknown, fallback: unknown): Record<string, unknown> {
  if (!evidenceRecord(resolved)) return evidenceRecord(fallback) ? fallback : {};
  return Object.fromEntries(
    Object.entries(resolved).flatMap(([slot, value]) => {
      if (
        !evidenceRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.version !== 'string'
      )
        return [];
      return [
        [slot, { pluginId: value.id, version: value.version, resolvedVersion: value.version }],
      ];
    }),
  );
}
