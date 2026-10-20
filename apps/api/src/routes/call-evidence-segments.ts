/**
 * Which routing segment each spoken line belongs to. The worker stamps `segment: <index>` on every
 * engine event row it writes (R2), and a later segment's engine ids carry its prefix (`s1:turn-1`),
 * so the engine event's own `segmentId` names the line. A call that never routed has no stamps.
 */
export function transcriptSegments(
  rows: readonly { payload: Record<string, unknown> }[],
): Map<string, number> {
  const found = new Map<string, number>();
  for (const { payload } of rows) {
    const event = payload.event;
    if (typeof payload.segment !== 'number' || !event || typeof event !== 'object') continue;
    const { segmentId } = event as { segmentId?: unknown };
    if (typeof segmentId === 'string' && !found.has(segmentId))
      found.set(segmentId, payload.segment);
  }
  return found;
}
