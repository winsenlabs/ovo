import { SPEECH_SCENARIOS } from './engine-scenarios-speech.ts';
import { TURN_SCENARIOS } from './engine-scenarios-turns.ts';
import type { EngineScenario } from './engine-scenario-setup.ts';

export type { EngineScenario } from './engine-scenario-setup.ts';

/** Every engine-kit scenario (§2.6), in order. */
export const ENGINE_SCENARIOS: readonly EngineScenario[] = [...TURN_SCENARIOS, ...SPEECH_SCENARIOS];
