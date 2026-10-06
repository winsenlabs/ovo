import { AgentToolSelectionError, type AgentToolErrorRecord } from './agent-tools.ts';
import type { DecisionGateResult } from './decision-gate.ts';
import type { GroundingResult } from './grounding.ts';

export interface AgentDecisionRecord {
  turn: number;
  result: DecisionGateResult;
  at: string;
}

export interface AgentGroundingRecord {
  turn: number;
  result: GroundingResult;
  at: string;
}

/** A spoken line this call's variables could not fill. The field path only: values are call data. */
export interface AgentSkippedLineRecord {
  turn: number;
  field: string;
  at: string;
}

/** Each list is capped, so a long call cannot grow memory through a repeating failure. */
const LIMIT = 100;

/**
 * What a session can be asked about afterwards: the tools inference tried to misuse, and every
 * decision asked with the confidence and calibration version behind it. Bounded and append-only;
 * it holds evidence, so nothing here changes the turn.
 */
export class AgentTurnLog {
  readonly toolErrors: AgentToolErrorRecord[] = [];
  readonly decisions: AgentDecisionRecord[] = [];
  readonly groundings: AgentGroundingRecord[] = [];
  readonly skippedLines: AgentSkippedLineRecord[] = [];

  /** A disabled policy is not an event; recording it would bury the ones that matter. */
  decision(turn: number, result: DecisionGateResult): void {
    if (result.kind === 'off') return;
    this.decisions.push({ turn, result, at: new Date().toISOString() });
    if (this.decisions.length > LIMIT) this.decisions.shift();
  }

  /** A disabled policy is not an event, for the same reason a disabled decision is not. */
  grounding(turn: number, result: GroundingResult): void {
    if (result.kind === 'off') return;
    this.groundings.push({ turn, result, at: new Date().toISOString() });
    if (this.groundings.length > LIMIT) this.groundings.shift();
  }

  skippedLine(turn: number, field: string): void {
    this.skippedLines.push({ turn, field, at: new Date().toISOString() });
    if (this.skippedLines.length > LIMIT) this.skippedLines.shift();
  }

  toolError(
    turn: number,
    toolId: string,
    kind: AgentToolErrorRecord['kind'],
    message: string,
  ): AgentToolSelectionError {
    this.toolErrors.push({ turn, toolId, kind, message, at: new Date().toISOString() });
    if (this.toolErrors.length > LIMIT) this.toolErrors.shift();
    return new AgentToolSelectionError(toolId, message);
  }
}
