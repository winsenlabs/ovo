import type { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import type { SimulationRequest, SimulationWarning } from '../wire/index.ts';

/**
 * The warnings of a run, in a fixed order (what the caller asked for, then what happened) so the
 * result stays byte-identical: clock override, an uncovered catalogue, live engines, unscripted
 * engines, turns left over, an aborted run.
 */
export function warningsOf(input: {
  snapshot: RoutingReleaseSnapshot;
  request: Omit<SimulationRequest, 'target'>;
  unscripted: readonly SimulationWarning[];
  unusedTurns: number;
  aborted: boolean;
  liveCalls: number;
}): SimulationWarning[] {
  const { snapshot, request } = input;
  const warnings: SimulationWarning[] = [];
  if (request.call.at)
    warnings.push({
      code: 'clock_overridden',
      message: `Time rules and member hours were read at ${request.call.at}, not now.`,
    });
  if (snapshot.transfer?.targets.length)
    warnings.push({
      code: 'transfer_not_simulated',
      message:
        'This release has a transfer catalogue; in-call transfers are not run by a simulation.',
    });
  const mode = request.engines.mode;
  if ([mode.decision, mode.llm, mode.external].includes('live'))
    warnings.push({
      code: 'live_engine_used',
      message: `${input.liveCalls} live engine call(s) were made and may have cost money.`,
    });
  warnings.push(...input.unscripted);
  if (input.unusedTurns > 0)
    warnings.push({
      code: 'turns_unused',
      message: `The route was decided before ${input.unusedTurns} caller turn(s) were used.`,
    });
  if (input.aborted)
    warnings.push({
      code: 'simulation_aborted',
      message: 'The simulation was stopped before the route was decided.',
    });
  return warnings;
}
