import type { CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import { draftSelections, requestedDraft, type DraftRouteInput } from '../draft-selections.ts';
import { requiredMeterChecklist } from '../required-meters.ts';

/** OPS-14: `GET /v1/agents/:agentId/required-meters`, the draft's cost checklist. */
export function registerRequiredMeterRoutes(
  input: DraftRouteInput & { ledger?: CostLedgerService },
) {
  input.app.get('/v1/agents/:agentId/required-meters', async (request, reply) => {
    const agent = await requestedDraft(request, input.store);
    let draft;
    try {
      draft = await draftSelections({ ...input, agent });
    } catch (error) {
      // Same failures the readiness route reports as blockers: a missing binding or plugin.
      return reply.code(409).send({
        error: 'selection_invalid',
        message: error instanceof Error ? error.message : 'Provider selection is invalid',
      });
    }
    const checklist = await requiredMeterChecklist({
      config: agent.config,
      selections: draft.selections,
      registry: draft.registry,
      bindings: Object.fromEntries(draft.bindingRows),
      ledger: input.ledger,
    });
    return { agentId: agent.id, draftVersion: agent.draftVersion, ...checklist };
  });
}
