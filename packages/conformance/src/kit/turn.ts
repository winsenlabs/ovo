import type { TurnDetectorFactory } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../drivers/fake-clock.ts';
import { type KitCheck } from './runner.ts';
import { Driver } from './turn-driver.ts';
import { TURN_SCENARIOS, type TurnScenario } from './turn-scenarios.ts';
import { TURN_VAD_SCENARIOS } from './turn-scenarios-vad.ts';

export type TurnDetectorKitFactory = () => TurnDetectorFactory | Promise<TurnDetectorFactory>;

export interface TurnKitContext {
  factory: TurnDetectorKitFactory;
}

export { TURN_SCENARIOS, type TurnScenario } from './turn-scenarios.ts';
export { TURN_VAD_SCENARIOS } from './turn-scenarios-vad.ts';

async function driver(context: TurnKitContext, scenario: TurnScenario): Promise<Driver> {
  const factory = await context.factory();
  const clock = new FakeClock();
  return new Driver(
    factory.create({
      clock,
      vad: scenario.vad ?? false,
      language: 'en-US',
      mode: scenario.mode,
      ...(scenario.overrides ? { overrides: scenario.overrides } : {}),
    }),
    clock,
  );
}

const SCENARIOS: readonly TurnScenario[] = [...TURN_SCENARIOS, ...TURN_VAD_SCENARIOS];

export const TURN_CHECKS: readonly KitCheck<TurnKitContext>[] = SCENARIOS.map((scenario) => ({
  name: scenario.name,
  async run(context: TurnKitContext) {
    const d = await driver(context, scenario);
    try {
      // Every scenario also proves the turn lifecycle: no turn ends that never started.
      return [...scenario.run(d), ...d.startedFailures()];
    } finally {
      d.controller.dispose();
    }
  },
}));
