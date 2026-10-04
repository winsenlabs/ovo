import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import {
  decisionCriteriaWhere,
  decisionHttpStep,
  describeDecision,
  type DecisionTemplate,
} from '@winsendotai/ovo-conformance';
import { resolveBinding } from '../src/binding.ts';
import { jevDecision } from '../src/decide.ts';
import { JEV_DOC_RETRIEVED, JEV_DOC_SOURCE, JEV_ENDPOINT, JEV_HOST } from '../src/wire.ts';

const LABEL = 'kit-cohort-2026-10';

/**
 * The kit's plan rendered as the Jev wire format pinned in `src/wire.ts`. Three translations are
 * forced by the published document, and each is named here because it changes what a kit check
 * means for this provider:
 *
 *  1. `modelId` → `model`. Jev reports the model that answered under `model`.
 *  2. `calibrationVersion` is REMOVED from every answer. Jev returns no such field (see README);
 *     the adapter composes it from the resolved `model` and `binding.calibrationLabel`.
 *  3. Because of (2), the kit's `calibration provenance` negative — which corrupts a reply by
 *     deleting `calibrationVersion` — has no wire form of its own here. Its intent is "the reply
 *     does not identify its cohort", and the only cohort-identifying fact Jev supplies is `model`,
 *     so that corruption is rendered as a reply with NO `model`. The adapter refuses it.
 */
const jevKitTemplate: DecisionTemplate = (plan) => {
  const steps = plan.exchanges.flatMap((exchange) => {
    const planned = exchange.response as {
      modelId?: string;
      answers: Record<string, Record<string, unknown>>;
    };
    let identifiesCohort = false;
    const answers: Record<string, Record<string, unknown>> = {};
    for (const [id, answer] of Object.entries(planned.answers)) {
      const { calibrationVersion, ...rest } = answer;
      if (calibrationVersion !== undefined) identifiesCohort = true;
      answers[id] = rest;
    }
    const body: Record<string, unknown> = {
      ...(identifiesCohort ? { model: planned.modelId ?? plan.model } : {}),
      answers,
      usage: { input_tokens: 120, output_tokens: 12 },
    };
    return [
      ...(exchange.delayMs ? [{ delayMs: exchange.delayMs }] : []),
      decisionHttpStep(
        JEV_ENDPOINT,
        { model: plan.model, ...decisionCriteriaWhere(exchange.request) },
        JSON.stringify(body),
      ),
    ];
  });
  return [{ host: JEV_HOST, source: JEV_DOC_SOURCE, retrieved: JEV_DOC_RETRIEVED, steps }];
};

describeDecision(
  'TypeSafe Jev decisions',
  ({ net, clock, usage, model }) =>
    jevDecision(
      net,
      'fixture-key',
      resolveBinding({ calibrationLabel: LABEL, model, timeoutMs: 10_000 }),
      usage,
      { sessionId: 'kit-session', clock },
    ),
  { template: jevKitTemplate },
);

// `createFixtureNet` is imported by the kit itself; this keeps the no-live-egress guarantee of this
// file explicit for a reader: nothing here constructs a real NetPort.
void createFixtureNet;
