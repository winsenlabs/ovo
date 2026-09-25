import type { SpeechEvidence, SpeechEvidencePhase } from '@winsendotai/ovo-contracts';
import type { EngineHarness } from './engine-harness.ts';
import { timingFailures, usageDeliveryFailures } from './engine-invariants-telemetry.ts';

const ORDER: readonly SpeechEvidencePhase[] = [
  'generated',
  'queued',
  'started',
  'sent',
  'acknowledged',
];
const TERMINAL = new Set<SpeechEvidencePhase>(['completed', 'interrupted', 'dropped', 'failed']);
/** Phases that prove audio for a segment was really on its way to the carrier. */
const PLAYING: readonly SpeechEvidencePhase[] = ['started', 'sent', 'acknowledged'];

function bySegment(harness: EngineHarness): Map<string, SpeechEvidence[]> {
  const out = new Map<string, SpeechEvidence[]>();
  for (const event of harness.events())
    if (event.type === 'speech') {
      const list = out.get(event.evidence.segmentId) ?? [];
      list.push(event.evidence);
      out.set(event.evidence.segmentId, list);
    }
  return out;
}

/** generated→queued→started→sent→acknowledged→completed|interrupted|dropped|failed, per segment. */
export function phaseOrderFailures(harness: EngineHarness): string[] {
  const failures: string[] = [];
  for (const [segment, phases] of bySegment(harness)) {
    let last = -1;
    let terminal = false;
    for (const evidence of phases) {
      if (terminal)
        failures.push(`segment ${segment}: phase ${evidence.phase} after a terminal phase`);
      if (TERMINAL.has(evidence.phase)) {
        terminal = true;
        continue;
      }
      const index = ORDER.indexOf(evidence.phase);
      if (index <= last)
        failures.push(`segment ${segment}: phase ${evidence.phase} is out of order`);
      last = Math.max(last, index);
    }
  }
  return failures;
}

/**
 * Ordering alone let an engine emit two phases and stop: dropping every 'queued' and
 * 'acknowledged' used to pass (#F14). Each segment must actually report its whole life.
 */
export function phaseCompletenessFailures(harness: EngineHarness): string[] {
  const failures: string[] = [];
  // A segment whose receipt was delivered is finished: it must have reported a terminal phase.
  const settled = new Set(harness.receipts().map((entry) => entry.receipt.id));
  for (const [segment, phases] of bySegment(harness)) {
    const seen = new Set(phases.map((evidence) => evidence.phase));
    const terminals = phases.filter((evidence) => TERMINAL.has(evidence.phase));
    for (const required of ['generated', 'queued'] as const)
      if (!seen.has(required)) failures.push(`segment ${segment}: no '${required}' phase`);
    if (terminals.length > 1 || (terminals.length === 0 && settled.has(segment)))
      failures.push(`segment ${segment}: ${terminals.length} terminal phases, expected one`);
    const end = terminals.at(-1);
    if (end?.phase === 'completed') {
      for (const required of ['started', 'sent'] as const)
        if (!seen.has(required))
          failures.push(`segment ${segment} completed without a '${required}' phase`);
      if (end.evidence === 'confirmed' && !seen.has('acknowledged'))
        failures.push(
          `segment ${segment} claims confirmed playback without an 'acknowledged' phase`,
        );
    }
  }
  return failures;
}

/** `sequence` is the stream's total order and `epoch` never goes backwards (#F13). */
export function monotonicityFailures(harness: EngineHarness): string[] {
  const failures: string[] = [];
  let sequence = 0;
  let epoch = 0;
  for (const event of harness.events()) {
    if (event.type !== 'speech') continue;
    const { evidence } = event;
    if (!(evidence.sequence > sequence))
      failures.push(
        `speech evidence sequence ${evidence.sequence} does not follow ${sequence} (segment ${evidence.segmentId})`,
      );
    sequence = Math.max(sequence, evidence.sequence);
    if (evidence.epoch < epoch)
      failures.push(
        `speech evidence epoch went back from ${epoch} to ${evidence.epoch} (segment ${evidence.segmentId})`,
      );
    epoch = Math.max(epoch, evidence.epoch);
  }
  return failures;
}

/**
 * Every segment that started playing before a turn is dispatched has its receipt delivered first.
 * Seeded from any playing phase, so suppressing 'started' no longer evades the rule (#F17).
 */
export function receiptOrderFailures(harness: EngineHarness): string[] {
  const failures: string[] = [];
  const started = new Map<string, { seq: number; id: string; text: string; epoch: number }>();
  for (const entry of harness.log)
    if (
      entry.kind === 'event' &&
      entry.event.type === 'speech' &&
      PLAYING.includes(entry.event.evidence.phase)
    ) {
      const e = entry.event.evidence;
      if (started.has(e.segmentId)) continue;
      started.set(e.segmentId, { seq: entry.seq, id: e.segmentId, text: e.text, epoch: e.epoch });
    }
  const receipts = harness.receipts();
  for (const respond of harness.responds()) {
    for (const segment of started.values()) {
      if (segment.seq > respond.seq) continue;
      const delivered = receipts.some(
        (r) =>
          r.seq < respond.seq &&
          (r.receipt.id === segment.id ||
            (r.receipt.text === segment.text && r.receipt.epoch === segment.epoch)),
      );
      if (!delivered)
        failures.push(
          `turn "${respond.input}" was dispatched before the receipt for "${segment.text}"`,
        );
    }
  }
  return failures;
}

function includes(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
  );
}

/** SessionInput.variables reach every behavior call (#4). */
export function variableFailures(harness: EngineHarness): string[] {
  return harness
    .responds()
    .filter(
      (respond) =>
        !includes(respond.variables, harness.session.variables as Record<string, unknown>),
    )
    .map((respond) => `behavior call "${respond.input}" did not receive the session variables`);
}

/** At most one Execution.execute per operation id. */
export function executionFailures(harness: EngineHarness): string[] {
  const counts = new Map<string, number>();
  for (const entry of harness.executes())
    counts.set(entry.request.id, (counts.get(entry.request.id) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => `operation ${id} executed ${count} times`);
}

export { timingFailures, usageDeliveryFailures } from './engine-invariants-telemetry.ts';

export function invariantFailures(harness: EngineHarness): string[] {
  return [
    ...phaseOrderFailures(harness),
    ...phaseCompletenessFailures(harness),
    ...monotonicityFailures(harness),
    ...receiptOrderFailures(harness),
    ...variableFailures(harness),
    ...executionFailures(harness),
    ...usageDeliveryFailures(harness),
    ...timingFailures(harness),
  ];
}
