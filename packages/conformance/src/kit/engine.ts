import { startHarness, type EngineKitContext } from './engine-harness.ts';
import { invariantFailures } from './engine-invariants.ts';
import { ENGINE_SCENARIOS } from './engine-scenarios.ts';
import { Failures, type KitCheck } from './runner.ts';

/**
 * Engine scenarios (§2.6) with the real behaviors from @winsendotai/ovo-behaviors. Every scenario
 * also asserts the cross-cutting rules: speech phases in order, receipts before the next turn,
 * session variables on every behavior call and at most one Execution.execute per operation.
 */
export const ENGINE_CHECKS: readonly KitCheck<EngineKitContext>[] = ENGINE_SCENARIOS.map(
  (scenario) => ({
    name: scenario.name,
    timeoutMs: 30_000,
    async run(context: EngineKitContext) {
      const harness = await startHarness(context, scenario.setup);
      const f = new Failures();
      try {
        await scenario.run(harness, f);
      } catch (error) {
        f.add(error instanceof Error ? error.message : String(error));
      } finally {
        await harness.close();
      }
      f.add(...invariantFailures(harness));
      return f.messages;
    },
  }),
);

export {
  startHarness,
  SESSION_VARIABLES,
  EngineHarness,
  type EngineKitContext,
  type EngineKitOptions,
  type HarnessEntry,
  type ScenarioSetup,
} from './engine-harness.ts';
export { ENGINE_SCENARIOS, type EngineScenario } from './engine-scenarios.ts';
export { invariantFailures } from './engine-invariants.ts';
