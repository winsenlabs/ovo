import type { AgentIdle } from '@winsendotai/ovo-contracts';
import type { RecoveryPlan } from './reprompt.ts';

/** The completion reason when the caller never answered the idle prompts. */
export const IDLE_COMPLETION = 'idle:no-input';

/**
 * Per-agent caller-silence escalation (AGT-11). The voice engine times the silence; this decides
 * what each silence says: the prompts in order, then the final line, after which the call ends.
 * Anything the caller says starts the escalation over.
 */
export class IdleLines {
  private count = 0;

  constructor(private readonly policy: AgentIdle) {}

  get timeoutMs(): number {
    return this.policy.timeoutMs;
  }

  reset(): void {
    this.count = 0;
  }

  /** The next silence's line (none for a final silence without a final line). */
  next(): RecoveryPlan {
    const { prompts, finalLine } = this.policy;
    this.count += 1;
    if (this.count <= prompts.length)
      return {
        lines: [{ field: `idle.prompts.${this.count - 1}`, text: prompts[this.count - 1]! }],
        idle: true,
      };
    return {
      lines: finalLine === undefined ? [] : [{ field: 'idle.finalLine', text: finalLine }],
      end: IDLE_COMPLETION,
      idle: true,
    };
  }
}
