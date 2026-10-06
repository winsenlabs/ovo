/**
 * The caller's words in progress, as the turn driver hands them to a behaviour that works ahead of
 * them (LAT-4). Structurally the contracts' `PartialUtterance` (`voice/turn.ts`, turns lane), read
 * from the behaviour without a cast: `AgentBehavior.prepare` and `discard` are its hooks.
 */
export interface PartialWords {
  turnId: string;
  text: string;
  /** Every word comes from a final STT segment, so the STT will not revise it. */
  stable: boolean;
  /** The variables the turn's `respond` will receive; the last turn's when absent. */
  variables?: Record<string, unknown>;
}

/** What the turn driver adds to a turn's variables; the session's own are the rest. */
const TURN_EVENT_KEYS = ['inputEvent', 'digits', 'answeredBy'];

/** The call's variables as a caller's spoken turn receives them, from any turn's variables. */
export function sessionVariables(variables: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(variables).filter(([key]) => !TURN_EVENT_KEYS.includes(key)),
  );
}
