import {
  CALL_OUTCOME_MAX_PATH,
  type CallOutcomeSummary,
  type SessionEvent,
} from '@winsendotai/ovo-contracts';

/** One stored session event, as the outcome endpoint returns it. */
export interface StoredSessionEvent {
  callId: string;
  sequence: number;
  at: string;
  type: SessionEvent['type'];
  payload: Record<string, unknown>;
}

/** Captured variables are merged per key; past this many keys, new ones are dropped. */
export const CALL_OUTCOME_MAX_VARIABLES = 100;

export function emptyCallOutcome(callId: string, at: string): CallOutcomeSummary {
  return {
    callId,
    outcome: null,
    endReason: null,
    disposition: null,
    dispositionSource: null,
    finalNode: null,
    statePath: [],
    variables: {},
    tiers: {},
    guardrail: { flagged: 0, blocked: 0 },
    events: 0,
    updatedAt: at,
  };
}

/**
 * Folds one event into the call's summary. Pure, so the Postgres and in-memory stores agree and the
 * summary can always be rebuilt from the events. The latest disposition wins: a call that first
 * promised to pay and was then transferred is reported as transferred.
 */
export function applySessionEvent(
  summary: CallOutcomeSummary,
  event: SessionEvent,
  at: string,
): CallOutcomeSummary {
  const next: CallOutcomeSummary = {
    ...summary,
    statePath: [...summary.statePath],
    variables: { ...summary.variables },
    tiers: { ...summary.tiers },
    guardrail: { ...summary.guardrail },
    events: summary.events + 1,
    updatedAt: at,
  };
  switch (event.type) {
    case 'turn.route': {
      const { tier, node } = event.payload;
      next.tiers[tier] = (next.tiers[tier] ?? 0) + 1;
      if (node && next.statePath.length === 0) enter(next, node);
      break;
    }
    case 'flow.state':
      enter(next, event.payload.to);
      break;
    case 'disposition':
      next.disposition = event.payload.disposition;
      next.dispositionSource = event.payload.source;
      if (event.payload.node) next.finalNode = event.payload.node;
      break;
    case 'variables.captured':
      for (const [key, value] of Object.entries(event.payload.variables)) {
        if (
          !Object.hasOwn(next.variables, key) &&
          Object.keys(next.variables).length >= CALL_OUTCOME_MAX_VARIABLES
        )
          continue;
        next.variables[key] = value;
      }
      break;
    case 'guardrail':
      next.guardrail[event.payload.action] += 1;
      break;
    case 'call.outcome':
      next.outcome = event.payload.outcome;
      next.endReason = event.payload.reason;
      if (event.payload.finalNode) next.finalNode = event.payload.finalNode;
      break;
  }
  return next;
}

/** The state path skips a repeated state (a reprompt stays where it is) and keeps the newest. */
function enter(summary: CallOutcomeSummary, node: string): void {
  summary.finalNode = node;
  if (summary.statePath.at(-1) === node) return;
  summary.statePath.push(node);
  if (summary.statePath.length > CALL_OUTCOME_MAX_PATH)
    summary.statePath.splice(0, summary.statePath.length - CALL_OUTCOME_MAX_PATH);
}
