import type {
  Behavior,
  PartialUtterance,
  SessionInput,
  TurnSpeculation,
} from '@winsendotai/ovo-contracts';

/**
 * The speculation hooks with the call's variables on every partial (LAT-4). A behaviour that judges
 * a partial ahead of the caller needs the call's data; without it here, a call where the caller
 * speaks before the agent has replied once had nothing to judge its first turn with. Caller turns
 * carry exactly the session's variables, so the partial gets the same copy the turn will.
 *
 * Each hook stays bound to the behaviour itself, so its state is never written anywhere else.
 */
export function withCallVariables(
  behavior: Behavior & TurnSpeculation,
  session: Pick<SessionInput, 'variables'>,
): Behavior & TurnSpeculation {
  const { prepare, finalize, discard } = behavior;
  return {
    respond: (input, variables) => behavior.respond(input, variables),
    ...(prepare
      ? {
          prepare: (partial: PartialUtterance) =>
            prepare.call(behavior, {
              ...partial,
              variables: structuredClone(session.variables),
            } as PartialUtterance),
        }
      : {}),
    ...(finalize ? { finalize: finalize.bind(behavior) } : {}),
    ...(discard ? { discard: discard.bind(behavior) } : {}),
  };
}
