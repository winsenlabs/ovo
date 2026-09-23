import { startHarness, type EngineKitContext } from './engine-harness.ts';
import { invariantFailures } from './engine-invariants.ts';
import { capabilityFailures } from './engine-invariants-telemetry.ts';
import { ENGINE_SCENARIOS } from './engine-scenarios.ts';
import { FAQ } from './engine-scenario-setup.ts';
import { Failures, type KitCheck } from './runner.ts';

/**
 * Engine scenarios (§2.6) with the real behaviors from @winsendotai/ovo-behaviors. Every scenario
 * also asserts the cross-cutting rules: speech phases in order and complete, receipts before the
 * next turn, session variables on every behavior call, usage delivered, at most one
 * Execution.execute per operation.
 */
const scenarioChecks: readonly KitCheck<EngineKitContext>[] = ENGINE_SCENARIOS.map((scenario) => ({
  name: scenario.name,
  timeoutMs: 30_000,
  async run(context: EngineKitContext, signal: AbortSignal) {
    const harness = await startHarness(context, scenario.setup);
    const f = new Failures();
    // An abandoned check must not leave a live engine behind (#F26).
    const abort = () => void harness.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      await scenario.run(harness, f);
    } catch (error) {
      f.add(error instanceof Error ? error.message : String(error));
    } finally {
      signal.removeEventListener('abort', abort);
      await harness.close();
    }
    f.add(...invariantFailures(harness));
    return f.messages;
  },
}));

export const ENGINE_CHECKS: readonly KitCheck<EngineKitContext>[] = [
  {
    name: 'the engine declares coherent EngineCapabilities',
    timeoutMs: 30_000,
    async run(context: EngineKitContext) {
      const harness = await startHarness(context, { agent: FAQ });
      try {
        await harness.say('what are your opening hours');
        await harness
          .until(() => harness.receipts().length > 0, 'the FAQ receipt')
          .catch(() => undefined);
        return capabilityFailures(harness, harness.events());
      } finally {
        await harness.close();
      }
    },
  },
  ...scenarioChecks,
];

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
export { capabilityFailures } from './engine-invariants-telemetry.ts';
