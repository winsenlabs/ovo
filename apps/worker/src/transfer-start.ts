import { disposeAttached } from './segment-prepare.ts';
import { carrierRefusal, segmentEnded } from './transfer-events.ts';
import type { LiveSegment, TransferControllerDeps, TransferRun } from './transfer-types.ts';

/**
 * A segment that failed to start (transfer design 7.2): its graph or queue is disposed, a
 * carrier's refusal (`carrier_refused:<reason>`) is kept on the run for the chain's record, and
 * `segment.ended` says `start_failed`. The caller is still on the line; the chain goes on.
 */
export async function failStart(input: {
  deps: Pick<TransferControllerDeps, 'audit' | 'record'>;
  live: LiveSegment;
  run: TransferRun;
  error: unknown;
  /** The call itself ended meanwhile: nothing to audit. */
  ended: boolean;
}): Promise<void> {
  const { deps, live, run } = input;
  const detail = carrierRefusal(input.error);
  if (detail) run.startError = detail;
  if (!input.ended)
    deps.audit('route.handoff.failed', {
      ...{ reason: 'start_failed', releaseId: live.segment.release.id },
      ...(detail ? { detail } : {}),
    });
  await disposeAttached(live, 'error:route-handoff-failed');
  deps.record(
    'segment.ended',
    segmentEnded(live, 'start_failed', 'start_failed', live.entry.startedAt),
  );
}
