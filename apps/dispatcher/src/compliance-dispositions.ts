import type { Logger } from '@winsendotai/ovo-contracts';
import { errorFields } from '@winsendotai/ovo-plugin-kit';
import type { DispositionLookup, OperationsService } from '@winsendotai/ovo-plugin-operations';
import type { CallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';

/** Reads each call's final flow disposition from the per-call outcome summaries. */
export function outcomeDispositions(
  outcomes: Pick<CallOutcomeStore, 'getMany'>,
  workspaceId: string,
): DispositionLookup {
  return async (callIds) => {
    const found = new Map<string, string>();
    for (const [callId, summary] of await outcomes.getMany(workspaceId, callIds))
      if (summary.disposition) found.set(callId, summary.disposition);
    return found;
  };
}

/**
 * The dispatcher's post-call compliance sweep (stage E7): every ended attempt's disposition is
 * folded into the recipient ledger, so a do-not-call, wrong-number or dispute ending stops the
 * next dial to that number. A failed sweep is logged and retried on the next tick.
 */
export function complianceDispositionTask(input: {
  operations: Pick<OperationsService, 'compliance'>;
  outcomes: Pick<CallOutcomeStore, 'getMany'>;
  workspaceId: string;
  logger: Logger;
}) {
  const lookup = outcomeDispositions(input.outcomes, input.workspaceId);
  return {
    id: 'compliance-dispositions',
    intervalMs: 15_000,
    jitterMs: 2_000,
    async tick(signal: AbortSignal) {
      signal.throwIfAborted();
      try {
        const applied = await input.operations.compliance.applyDispositions(lookup);
        if (applied) input.logger.info('compliance_dispositions_applied', { applied });
      } catch (error) {
        input.logger.warn('compliance_dispositions_failed', errorFields(error));
      }
    },
  };
}
