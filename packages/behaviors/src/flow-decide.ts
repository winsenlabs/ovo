import type {
  DecisionPort,
  DecisionRequest,
  DecisionStateSource,
  DecisionTrace,
} from '@winsendotai/ovo-contracts';
import type { DecisionTurn } from './decision-gate.ts';
import { spokenHistory } from './history.ts';

export interface DecisionClock {
  timeout(ms: number): AbortSignal;
}

export const SYSTEM_DECISION_CLOCK: DecisionClock = { timeout: (ms) => AbortSignal.timeout(ms) };

export type DecisionCall =
  { ok: true; response: unknown } | { ok: false; reason: 'timeout' | 'error'; message: string };

/**
 * One decision round trip under the authored deadline, shared by the flat policy, the flow and a
 * script. A slow or failing model is reported, never thrown: a decision sits in front of the
 * reply, and its failure must not drop a live call. A cancelled turn still throws, because the
 * caller has moved on and nothing should be said for it.
 */
export async function callDecision(
  port: DecisionPort | undefined,
  request: DecisionRequest,
  options: {
    timeoutMs: number;
    signal: AbortSignal;
    clock?: DecisionClock;
    trace?: DecisionTrace;
  },
): Promise<DecisionCall> {
  if (!port)
    return {
      ok: false,
      reason: 'error',
      message: 'No decision plugin is available for a configured decision policy',
    };
  const deadline = (options.clock ?? SYSTEM_DECISION_CLOCK).timeout(options.timeoutMs);
  try {
    const response = await port.decide(request, {
      signal: AbortSignal.any([options.signal, deadline]),
      ...(options.trace ? { trace: options.trace } : {}),
    });
    options.signal.throwIfAborted();
    return { ok: true, response };
  } catch (error) {
    // A cancelled turn is not a decision failure; the caller is already gone.
    options.signal.throwIfAborted();
    if (deadline.aborted)
      return {
        ok: false,
        reason: 'timeout',
        message: `Decision did not answer within ${options.timeoutMs}ms`,
      };
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A flow's decision state, as the POC sent it: the reply, what the agent said since the caller last
 * spoke (what the reply most likely answers), the recent turns, and today for relative dates. The
 * policy's `variables`, `context` and `knowledge` sources add to it; the others are always present.
 */
export function flowDecisionState(
  turn: DecisionTurn,
  transcriptTurns: number,
  sources: readonly DecisionStateSource[],
): Record<string, unknown> {
  const spoken = spokenHistory(turn.history);
  const lastCaller = spoken.findLastIndex((entry) => entry.role === 'user');
  const state: Record<string, unknown> = {
    caller_reply: turn.input,
    agent_last_said: spoken
      .slice(lastCaller + 1)
      .map((entry) => entry.content)
      .join(' '),
    recent_turns: spoken
      .slice(-transcriptTurns)
      .map((entry) => `${entry.role === 'user' ? 'caller' : 'agent'}: ${entry.content}`),
    today: turn.today ?? '',
  };
  for (const source of sources) {
    if (source === 'variables') state.variables = turn.variables;
    else if (source === 'context') state.briefing = turn.context;
    else if (source === 'knowledge') state.retrieved = turn.retrieved ?? '';
  }
  return state;
}
