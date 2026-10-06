/**
 * The decision state a flow call sends, built the way the runtime builds it. Stand-in for the flow
 * lane's `flowDecisionState` (wave3/flow `behaviors/src/flow-decide.ts`) and the agent's
 * `AgentVariables.today()`. Once the flow runtime is integrated, the agent-runtime goldens drive
 * the agent to every decided eval case and require the exact request this builds.
 */

/** One played line or one caller reply, in call order. */
export interface SpokenEntry {
  role: 'agent' | 'caller';
  text: string;
}

/** The flow runtime's default `decision.state.transcriptTurns`. */
export const FLOW_TRANSCRIPT_TURNS = 6;

/**
 * Mirrors `flowDecisionState` (wave3/flow `behaviors/src/flow-decide.ts`) for a policy with no
 * extra state sources: the reply, everything the agent said since the caller last spoke, the last
 * turns of the spoken history (which does not yet hold this reply), and today as the agent formats
 * it.
 */
export function flowDecisionState(
  reply: string,
  spoken: readonly SpokenEntry[],
  today: string,
  transcriptTurns = FLOW_TRANSCRIPT_TURNS,
): Record<string, unknown> {
  const lastCaller = spoken.findLastIndex((entry) => entry.role === 'caller');
  return {
    caller_reply: reply,
    agent_last_said: spoken
      .slice(lastCaller + 1)
      .map((entry) => entry.text)
      .join(' '),
    recent_turns: spoken.slice(-transcriptTurns).map((entry) => `${entry.role}: ${entry.text}`),
    today,
  };
}

/** `AgentVariables.today()`: the date in the agent's locale and timezone, weekday included. */
export function flowToday(clock: { now: string; locale: string; timezone: string }): string {
  return new Intl.DateTimeFormat(clock.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: clock.timezone,
  }).format(new Date(clock.now));
}
