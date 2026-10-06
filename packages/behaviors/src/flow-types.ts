import type {
  CompiledFlow,
  DecisionPort,
  DecisionStateSource,
  FlowTransition,
} from '@winsendotai/ovo-contracts';
import type { DecisionClock } from './flow-decide.ts';

/** An authored line, by id, as the step will render it. */
export interface FlowLine {
  id: string;
  template: string;
}

/** What the flow wants this turn to do. Nothing moves until the step is committed. */
export type FlowStep =
  | { kind: 'enter'; node: string; lines: FlowLine[]; end: boolean; transition: FlowTransition }
  | { kind: 'repeat'; lines: FlowLine[]; transition: FlowTransition }
  | {
      kind: 'fallback';
      /** `llm` answers the reply and rejoins; `clarify` asks again and stays put. */
      action: 'llm' | 'clarify';
      line?: FlowLine;
      transition: FlowTransition;
      unavailable?: { reason: 'timeout' | 'error' | 'invalid'; message: string };
    };

/** The instant tier: an intent key of `listen` for this reply, or undefined to ask the model. */
export type FlowRules = (reply: string, listen: string, flow: CompiledFlow) => string | undefined;

export interface FlowSessionOptions {
  port?: DecisionPort;
  timeoutMs: number;
  transcriptTurns?: number;
  /** Extra decision state on top of the reply, the last line, the recent turns and today. */
  sources?: readonly DecisionStateSource[];
  clock?: DecisionClock;
  now?: () => Date;
  /** Defaults to the intents' exact phrases. A richer rules tier (lexicons) plugs in here. */
  rules?: FlowRules;
}

/** Shown to the LLM instead of the call facts until a node confirms who is on the line. */
export const UNVERIFIED_FACTS_NOTICE =
  'Identity is not confirmed yet. Do not reveal any account details, amounts, dates, or that ' +
  'money is owed. You may only say, in general terms, why you are calling, and confirm who you ' +
  'are speaking with.';
