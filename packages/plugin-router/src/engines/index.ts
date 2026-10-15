import type {
  DecisionPort,
  Inference,
  RoutingEngine,
  RoutingHost,
} from '@winsendotai/ovo-contracts';
import { createDecisionRunner } from './decision.ts';
import { createExternalRunner } from './external.ts';
import { createLlmRunner } from './llm.ts';
import { createRulesRunner, hasInstantRule } from './rules.ts';
import type { EngineRunners } from './types.ts';

export * from './types.ts';
export { createDecisionRunner, routeDecisionRequest, ROUTE_QUESTION_ID } from './decision.ts';
export { createExternalRunner } from './external.ts';
export { createLlmRunner, routeContext, routeTool } from './llm.ts';
export { createRulesRunner, hasInstantRule, matches, type RulesEnv } from './rules.ts';

/** The production engines over the router's ports. Absent ports make their engines `disabled`. */
export function createEngineRunners(ports: {
  host: RoutingHost;
  decision?: DecisionPort;
  inference?: Inference;
}): EngineRunners {
  return {
    rules: createRulesRunner(ports.host),
    decision: createDecisionRunner(ports.decision),
    llm: createLlmRunner(ports.inference),
    external: createExternalRunner(ports.host),
  };
}

/**
 * Whether an engine can decide before the caller has said anything (the opening): rules with a
 * rule made only of caller-id, time and variable matchers, and an external engine that is not sent
 * the caller's words.
 */
export function isInstantEngine(engine: RoutingEngine): boolean {
  if (engine.kind === 'rules') return hasInstantRule(engine);
  return engine.kind === 'external' && !engine.send.turnText;
}
