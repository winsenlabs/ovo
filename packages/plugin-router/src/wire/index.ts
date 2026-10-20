/*
 * The simulation and eval wire shapes live in `@winsendotai/ovo-contracts` (routing/simulate.ts,
 * simulate-result.ts, eval.ts, scorecard.ts) so the API and the console read the same definitions;
 * the plugin imports them through this single point.
 */
export {
  ROUTING_EVAL_LIMITS,
  ROUTING_EVAL_SCHEMA,
  ROUTING_SCORECARD_SCHEMA,
  RoutingEvalCase,
  RoutingEvalExpect,
  SIMULATED_ENGINES,
  SIMULATION_LIMITS,
  SIMULATION_SCHEMA,
  SimulatedAnswer,
  SimulationCall,
  SimulationFaults,
  SimulationRequest,
  SimulationTurn,
  type EvalRate as Rate,
  type PoolConsideration,
  type RoutingScorecard,
  type RoutingSimulationResult,
  type SimulationOutcome,
  type SimulationStep,
  type SimulationTurnResult,
  type SimulationWarning,
  type SimulationWarningCode,
} from '@winsendotai/ovo-contracts';
