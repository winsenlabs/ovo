import type { EngineEvent } from '@winsendotai/ovo-contracts';

export async function allEvidencePages<T>(
  list: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor);
    items.push(...page.items);
    if (items.length > 10_000) throw new Error('Call evidence exceeds the inspection limit');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export function evidenceRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function evidenceEngineEvent(value: unknown): value is EngineEvent {
  return evidenceRecord(value) && typeof value.type === 'string';
}

export function evidencePaise(rows: readonly { amountMinor: string }[]): string {
  return rows.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n).toString();
}

/** Reuse the engine transcript projector for text simulations' durable input/output rows. */
export function simulationTranscriptEvents(
  rows: readonly { id: string; type: string; payload: Record<string, unknown> }[],
): EngineEvent[] {
  return rows.flatMap<EngineEvent>((row) => {
    if (row.type === 'simulation.input' && typeof row.payload.input === 'string')
      return [
        {
          type: 'user.transcript',
          turnId: String(row.payload.epoch ?? 0),
          segmentId: row.id,
          text: row.payload.input,
          stability: 'final',
        },
      ];
    if (row.type === 'simulation.output' && typeof row.payload.text === 'string')
      return [
        { type: 'agent.transcript', segmentId: row.id, text: row.payload.text, state: 'generated' },
      ];
    return [];
  });
}
