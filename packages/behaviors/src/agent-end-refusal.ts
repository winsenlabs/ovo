import { END_CALL_TOOL_ID, type OperationRecord } from '@winsendotai/ovo-contracts';
import type { AgentTurnLog } from './agent-turn-log.ts';

/**
 * N1, on one inference step: whether the LLM's `end_call` is refused (`EndCallGate`'s verdict for
 * the turn, or the step's own text just asked a question), recorded on `toolErrors` as `refused`.
 * Its `publish` remembers what the step said last.
 */
export class EndCallRefusal {
  private said = '';

  constructor(
    private readonly step: {
      publish: (text: string) => string;
      endRefused?: () => string | undefined;
      log: AgentTurnLog;
      turn: number;
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
    const asked = afterText && /[?？؟]\s*$/u.test(this.said);
    const why =
      this.step.endRefused?.() ?? (asked ? 'the agent has just asked a question' : undefined);
    if (why)
      this.step.log.toolError(
        this.step.turn,
        END_CALL_TOOL_ID,
        'refused',
        `end_call refused: ${why}`,
      );
    return why;
  }

  /** The record a refused `end_call` leaves for the model's next step. */
  record(input: unknown, why: string): OperationRecord {
    return {
      id: this.step.operationId(),
      ...this.step.identity,
      toolId: END_CALL_TOOL_ID,
      input,
      state: 'failed',
      error: `The call was not ended: ${why}. Do not say goodbye; answer the caller.`,
      createdAt: new Date().toISOString(),
    };
  }
}
