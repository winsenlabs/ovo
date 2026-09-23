import type { SpeechEvidence, SpeechEvidencePhase } from '@winsendotai/ovo-contracts';
import type { EngineHarness } from './engine-harness.ts';

const ORDER: readonly SpeechEvidencePhase[] = [
  'generated',
  'queued',
  'started',
  'sent',
  'acknowledged',
];
const TERMINAL = new Set<SpeechEvidencePhase>(['completed', 'interrupted', 'dropped', 'failed']);

/** generated→queued→started→sent→acknowledged→completed|interrupted|dropped|failed, per segment. */
export function phaseOrderFailures(harness: EngineHarness): string[] {
  const bySegment = new Map<string, SpeechEvidence[]>();
  for (const event of harness.events())
    if (event.type === 'speech') {
      const list = bySegment.get(event.evidence.segmentId) ?? [];
      list.push(event.evidence);
      bySegment.set(event.evidence.segmentId, list);
    }
  const failures: string[] = [];
  for (const [segment, phases] of bySegment) {
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

/** Every segment that started playing before a turn is dispatched has its receipt delivered first. */
export function receiptOrderFailures(harness: EngineHarness): string[] {
  const failures: string[] = [];
  const started: { seq: number; id: string; text: string; epoch: number }[] = [];
  for (const entry of harness.log)
    if (
      entry.kind === 'event' &&
      entry.event.type === 'speech' &&
      entry.event.evidence.phase === 'started'
    ) {
      const e = entry.event.evidence;
      started.push({ seq: entry.seq, id: e.segmentId, text: e.text, epoch: e.epoch });
    }
  const receipts = harness.receipts();
  for (const respond of harness.responds()) {
    for (const segment of started) {
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

export function invariantFailures(harness: EngineHarness): string[] {
  return [
    ...phaseOrderFailures(harness),
    ...receiptOrderFailures(harness),
    ...variableFailures(harness),
    ...executionFailures(harness),
  ];
}
