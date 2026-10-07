import { agentLlmPaths, meterApplies } from '@winsendotai/ovo-contracts';
import { speculationPolicy } from '@winsendotai/ovo-behaviors';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';

/**
 * LAT-3: an agent that asks the LLM alongside its decision (`decision.speculation.llm`) pays for
 * the calls it aborts whenever the decision answers first, so its price must be known. On by
 * default; a warning, never a blocker, at every stage: the agent still runs, but its cost is a guess.
 *
 * A price reference counts as confirmed only when whoever resolved it says it is not provisional
 * (`provisional: false`, as a ledger card carries it). A bare `{ id, version }` reference cannot
 * say, so it is treated as provisional; the API resolves references against the ledger first.
 */
export const speculativeLlmUnpriced: CompatRule = (input, stage) => {
  const { config } = input;
  if (!config.decision?.enabled || !speculationPolicy(config.decision).llm) return [];
  if (!agentLlmPaths(config).length) return [];
  const llm = resolved(input).find((entry) => entry.slot === 'llm');
  const binding =
    llm?.choice.binding?.config ??
    (llm?.choice.bindingId ? input.bindings?.[llm.choice.bindingId]?.config : undefined) ??
    {};
  const meters = llm
    ? (manifestKeys(llm.definition.manifest).manifest.meters ?? []).filter(
        (meter) => meter.role === 'llm' && meterApplies(meter, binding),
      )
    : [];
  const unconfirmed = meters
    .map((meter) => meter.key)
    .filter((key) => !confirmed(input.priceCards?.[key]));
  if (meters.length && !unconfirmed.length) return [];
  const covering = unconfirmed.length ? unconfirmed.join(', ') : 'the selected LLM';
  return [
    issue(
      'meter_uncovered',
      stage,
      `Speculative LLM calls are billed even when the decision answers first, and no ` +
        `confirmed (non-provisional) price card covers ${covering}`,
      {
        slot: 'llm',
        field: 'decision.speculation.llm',
        ...(llm ? { pluginId: llm.choice.pluginId } : {}),
      },
      'warning',
    ),
  ];
};

function confirmed(reference: unknown): boolean {
  return (
    !!reference &&
    typeof reference === 'object' &&
    (reference as { provisional?: unknown }).provisional === false
  );
}
