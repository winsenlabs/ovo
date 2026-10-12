import { END_CALL_TOOL_ID, type OperationRecord } from '@winsendotai/ovo-contracts';
import { askToEndLine, END_REFUSED } from './agent-end-gate.ts';
import type { AgentTurnLog } from './agent-turn-log.ts';

/**
 * N1, on one inference step: whether the LLM's `end_call` is refused (`EndCallGate`'s verdict for
 * the turn, or the step's own text just asked a question), recorded on `toolErrors` as `refused`.
 * Its `publish` remembers what the step said last.
 */
export class EndCallRefusal {
  private said = '';
  /** Owed after a refused streamed goodbye (`afterText`). */
  private owed?: string;

  constructor(
    private readonly step: {
      publish: (text: string) => string;
      endRefused?: () => string | undefined;
      log: AgentTurnLog;
      turn: number;
      /** The agent's language, for the line asking whether to end the call. */
      language: string;
      operationId: () => string;
      identity: { workspaceId: string; sessionId: string };
    },
  ) {}

  publish = (text: string): string => {
    this.said = text;
    return this.step.publish(text);
  };

  /** Why `end_call` is refused, `afterText` the step's own; undefined when it may end the call. */
  refused(afterText: boolean): string | undefined {
    const asked = afterText && this.askedQuestion();
    const why = asked ? 'the agent has just asked a question' : this.step.endRefused?.();
    if (why)
      this.step.log.toolError(
        this.step.turn,
        END_CALL_TOOL_ID,
        'refused',
        `end_call refused: ${why}`,
      );
    return why;
  }

  /**
   * The model's valid `end_call` after its streamed text: `end` runs unless it is refused, and a
   * refusal the caller should settle leaves its question for `takeAsk` (Wave 8b).
   */
  afterText(end: () => void): void {
    const why = this.refused(true);
    if (why) this.owed = this.ask(why);
    else end();
  }

  /** The question a refused streamed goodbye left, said once after it. */
  takeAsk(): string | undefined {
    const ask = this.owed;
    this.owed = undefined;
    return ask;
  }

  /**
   * Wave 8b: the line to say for a refused `end_call` the caller should settle: they may want to
   * end the call but did not clearly ask, or were not heard clearly. The agent asks and waits; a
   * yes ends the call (`EndCallGate`). Never after a question of the agent's own.
   */
  ask(why: string): string | undefined {
    if (why !== END_REFUSED.unasked && why !== END_REFUSED.unheard) return undefined;
    return this.askedQuestion() ? undefined : askToEndLine(this.step.language);
  }

  /** The record a refused `end_call` leaves for the model's next step. */
  record(input: unknown, why: string): OperationRecord {
    const instead =
      why === END_REFUSED.unasked || why === END_REFUSED.unheard
        ? 'ask the caller whether they want to end the call, and wait for their answer'
        : 'answer the caller';
    return {
      id: this.step.operationId(),
      ...this.step.identity,
      toolId: END_CALL_TOOL_ID,
      input,
      state: 'failed',
      error: `The call was not ended: ${why}. Do not say goodbye; ${instead}.`,
      createdAt: new Date().toISOString(),
    };
  }

  /** The step's text so far ends on a question. */
  private askedQuestion(): boolean {
    return /[?？؟]\s*$/u.test(this.said);
  }
}
